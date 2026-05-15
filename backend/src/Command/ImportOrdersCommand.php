<?php

namespace App\Command;

use App\Entity\Order;
use App\Entity\OrderItem;
use App\Entity\Product;
use App\Repository\OrderRepository;
use App\Repository\ProductRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Imports orders + products from the JSON file produced by the Python scraper.
 *
 * Usage:
 *   php bin/console app:import-orders ../scraper/orders.json
 *
 * Idempotent: if an order with the same reference already exists, it is updated
 * in place and its items replaced. Products are de-duplicated by reference,
 * then by name.
 */
#[AsCommand(name: 'app:import-orders', description: 'Import scraped orders JSON into the database')]
final class ImportOrdersCommand extends Command
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly OrderRepository $orders,
        private readonly ProductRepository $products,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->addArgument('file', InputArgument::REQUIRED, 'Path to the orders.json file');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $path = (string) $input->getArgument('file');
        if (!is_file($path)) {
            $io->error("File not found: $path");
            return Command::FAILURE;
        }

        $payload = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        $rows = $payload['orders'] ?? [];
        $io->title(sprintf('Importing %d orders from %s', count($rows), $path));

        $createdProducts = 0;
        $createdOrders = 0;
        $updatedOrders = 0;
        $mergedDupes = 0;
        $skippedNoRef = 0;

        // In-batch cache of Order entities keyed by reference. When two input
        // rows share a reference (the scraper saw the same order twice, or the
        // shop legitimately split it across multiple history rows), we merge
        // them into a single Order rather than crashing on a unique-key error.
        $byReference = [];

        // In-batch cache of Product entities keyed by reference. Doctrine
        // doesn't flush between iterations, so without this cache the same
        // product reference appearing in two different orders would each look
        // up the DB (still empty before flush), create a new Product, and the
        // unique constraint on Product.reference would explode at flush time.
        $productByRef = [];

        foreach ($rows as $r) {
            $reference = (string) ($r['reference'] ?? '');
            if ($reference === '') {
                continue;
            }

            if (isset($byReference[$reference])) {
                // Already saw this reference in this batch — reuse the Order
                // entity and just append the products from this row.
                $order = $byReference[$reference];
                $mergedDupes++;
                // Opportunistically backfill any metadata the first row didn't have
                if (!$order->getStatus() && !empty($r['status'])) {
                    $order->setStatus((string) $r['status']);
                }
                if (!$order->getTotal() && !empty($r['total'])) {
                    $order->setTotal($r['total']);
                }
                if (!$order->getPayment() && !empty($r['payment'])) {
                    $order->setPayment($r['payment']);
                }
                if (!$order->getDetailUrl() && !empty($r['detail_url'])) {
                    $order->setDetailUrl($r['detail_url']);
                }
                if (!$order->getDate()) {
                    $order->setDate(self::parseDate((string) ($r['date'] ?? '')));
                }
            } else {
                $order = $this->orders->findOneByReference($reference);
                if ($order) {
                    // Update in place — drop existing items so we can rebuild from scratch.
                    foreach ($order->getItems() as $existing) {
                        $this->em->remove($existing);
                    }
                    $updatedOrders++;
                } else {
                    $order = new Order();
                    $order->setReference($reference);
                    $this->em->persist($order);
                    $createdOrders++;
                }

                $order->setStatus((string) ($r['status'] ?? ''));
                $order->setTotal($r['total'] ?? null);
                $order->setPayment($r['payment'] ?? null);
                $order->setDetailUrl($r['detail_url'] ?? null);
                $order->setRawDate($r['raw_date'] ?? null);
                $order->setDate(self::parseDate((string) ($r['date'] ?? '')));

                $byReference[$reference] = $order;
            }

            foreach (($r['products'] ?? []) as $p) {
                $name = trim((string) ($p['name'] ?? ''));
                if ($name === '') {
                    continue;
                }
                // Products without a usable reference are skipped entirely —
                // we don't import them as orderless rows or as name-only
                // products. The scraper writes "" when the detail page had no
                // "Référence:" line for that item; we treat that the same as
                // a missing reference.
                $ref = $p['reference'] ?? null;
                if ($ref === null || !is_string($ref) || trim($ref) === '') {
                    $skippedNoRef++;
                    continue;
                }
                $ref = trim($ref);

                $product = null;

                // 1. In-batch cache (same reference seen earlier in this run)
                if (isset($productByRef[$ref])) {
                    $product = $productByRef[$ref];
                }
                // 2. Database lookup (handles re-imports finding existing rows)
                if (!$product) {
                    $product = $this->products->findOneByReferenceOrName($ref, $name);
                }
                // 3. Create a new Product if neither cache nor DB had one
                if (!$product) {
                    $product = new Product();
                    $product->setName($name);
                    $product->setReference($ref);
                    $this->em->persist($product);
                    $createdProducts++;
                }
                $productByRef[$ref] = $product;

                // Note: barcodes are now a separate one-to-many entity
                // (ProductBarcode). The scraper doesn't extract barcodes from
                // koreancosmetics.fr (they aren't shown on the order detail
                // page), so we don't try to seed any here. Barcodes are added
                // manually via the Products page in the UI.

                $item = new OrderItem();
                $item->setProduct($product);
                $item->setQuantity((int) ($p['quantity'] ?? 1));
                $item->setUnitPrice($p['unit_price'] ?? null);
                $item->setUnitPriceNumeric(self::parsePriceToDecimal($p['unit_price'] ?? null));
                $item->setTotalPrice($p['total_price'] ?? null);
                $order->addItem($item);
                $this->em->persist($item);
            }
        }

        $this->em->flush();

        $io->success(sprintf(
            'Done. %d orders created, %d updated, %d new products, %d duplicate row(s) merged, %d product line(s) skipped (no reference).',
            $createdOrders, $updatedOrders, $createdProducts, $mergedDupes, $skippedNoRef
        ));
        return Command::SUCCESS;
    }

    /**
     * Parse a French-formatted price string ("10,92 €", "1 234,56 €", "10.92")
     * into a decimal string suitable for a decimal(10,4) column. Returns null
     * if no number can be extracted.
     */
    private static function parsePriceToDecimal(?string $raw): ?string
    {
        if ($raw === null || trim($raw) === '') {
            return null;
        }
        $s = str_replace(["\xc2\xa0", ' '], '', $raw); // strip nbsp + ordinary spaces
        $s = preg_replace('/[^0-9,.\-]/u', '', $s);
        if ($s === null || $s === '') {
            return null;
        }
        if (str_contains($s, ',') && str_contains($s, '.')) {
            $s = str_replace('.', '', $s);
        }
        $s = str_replace(',', '.', $s);
        return is_numeric($s) ? (string) ((float) $s) : null;
    }

    private static function parseDate(string $raw): ?\DateTimeImmutable
    {
        $raw = trim($raw);
        if ($raw === '') return null;

        // Try ISO first, then common French formats
        foreach (['Y-m-d', 'd/m/Y', 'd-m-Y', 'd/m/y'] as $fmt) {
            $d = \DateTimeImmutable::createFromFormat($fmt, $raw);
            if ($d !== false) return $d;
        }
        try {
            return new \DateTimeImmutable($raw);
        } catch (\Throwable) {
            return null;
        }
    }
}
