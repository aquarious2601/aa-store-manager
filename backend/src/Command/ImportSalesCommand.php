<?php

namespace App\Command;

use App\Entity\ProductBarcode;
use App\Entity\Sale;
use App\Entity\SaleItem;
use App\Repository\ProductRepository;
use App\Repository\SaleRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Imports the JSON produced by scrape_sales.py.
 *
 * Idempotent: a sale whose reference already exists is updated in place
 * (items are dropped and rebuilt). Items reference an existing Product
 * when their product_reference matches a Product.reference in the DB;
 * otherwise the description is stored verbatim with product=null (service
 * lines).
 */
#[AsCommand(name: 'app:import-sales', description: 'Import scraped sales JSON into the database')]
final class ImportSalesCommand extends Command
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly SaleRepository $sales,
        private readonly ProductRepository $products,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->addArgument('file', InputArgument::REQUIRED, 'Path to sales.json');
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
        $rows = $payload['sales'] ?? [];
        $io->title(sprintf('Importing %d sales from %s', count($rows), $path));

        $created = 0;
        $updated = 0;
        $mergedDupes = 0;
        $linkedToProduct = 0;
        $serviceLines = 0;

        // Tiny in-memory cache of Product lookups (reference → entity)
        $productCache = [];

        // In-batch cache of Sale entities keyed by reference. When the same
        // invoice reference appears more than once in the input (scraper saw
        // the same row twice, or Dolibarr legitimately split it), we merge
        // the second occurrence into the entity already pending in Doctrine's
        // unit of work rather than crashing on the unique-key constraint.
        $byReference = [];

        foreach ($rows as $r) {
            $reference = trim((string) ($r['reference'] ?? ''));
            if ($reference === '') {
                continue;
            }

            if (isset($byReference[$reference])) {
                // Already saw this reference this run — the duplicate is almost
                // always the same invoice scraped twice, so its items would be
                // identical to the first occurrence's. SKIP entirely to avoid
                // doubling line items in the DB. (For orders we MERGE items
                // because there split invoices can legitimately appear twice
                // with different items; for sales the scraper now dedups at
                // source, so this branch is purely defensive.)
                $mergedDupes++;
                continue;
            } else {
                $sale = $this->sales->findOneByReference($reference);
                if ($sale) {
                    // Update in place — wipe existing items so we can rebuild
                    foreach ($sale->getItems() as $existing) {
                        $this->em->remove($existing);
                    }
                    $updated++;
                } else {
                    $sale = new Sale();
                    $sale->setReference($reference);
                    $this->em->persist($sale);
                    $created++;
                }

                $sale->setRawDate($r['raw_date'] ?? null);
                $sale->setDate(self::parseDate((string) ($r['date'] ?? '')));
                $sale->setDetailUrl($r['detail_url'] ?? null);

                $byReference[$reference] = $sale;
                $sumHt = 0.0;
                $sumTtc = 0.0;
            }

            foreach (($r['items'] ?? []) as $it) {
                $item = new SaleItem();
                $item->setDescription((string) ($it['description'] ?? ''));
                $item->setVatRate(self::numericOrNull($it['vat_rate'] ?? null));
                $item->setUnitPriceHt(self::numericOrNull($it['unit_price_ht'] ?? null));
                $item->setQuantity((int) ($it['quantity'] ?? 1));
                $item->setTotalHt(self::numericOrNull($it['total_ht'] ?? null));
                $item->setTotalTtc(self::numericOrNull($it['total_ttc'] ?? null));

                // Three-tier Product matching:
                //   1. preferred: by reference (PRDX1605 etc.) when the scraper got it.
                //   2. by exact-name match for "product" kind lines that lost their <a>.
                //   3. by barcode embedded in the description — useful both for
                //      product lines without a ref AND for "service" kind lines
                //      whose description happens to contain a barcode
                //      (e.g. "Service: 8809684563861 cream"). We look it up in
                //      the product_barcodes table since a Product can have many.
                $kind  = (string) ($it['kind'] ?? 'product');
                $pref  = isset($it['product_reference']) ? trim((string) $it['product_reference']) : '';
                $descr = trim((string) ($it['description'] ?? ''));

                $matched = null;

                // Tier 1 — by reference
                if ($pref !== '') {
                    $cacheKey = 'ref:' . $pref;
                    if (!array_key_exists($cacheKey, $productCache)) {
                        $productCache[$cacheKey] = $this->products->findOneBy(['reference' => $pref]);
                    }
                    $matched = $productCache[$cacheKey];
                }

                // Tier 2 — by exact name (case-insensitive), product lines only
                if (!$matched && $kind === 'product' && $descr !== '') {
                    $cacheKey = 'name:' . mb_strtolower($descr);
                    if (!array_key_exists($cacheKey, $productCache)) {
                        // Case-insensitive exact-name lookup. We deliberately avoid
                        // LIKE/fuzzy matches here — they cause false positives that
                        // are hard to debug.
                        $productCache[$cacheKey] = $this->products
                            ->createQueryBuilder('p')
                            ->where('LOWER(p.name) = :n')
                            ->setParameter('n', mb_strtolower($descr))
                            ->setMaxResults(1)
                            ->getQuery()
                            ->getOneOrNullResult();
                    }
                    $matched = $productCache[$cacheKey];
                }

                // Tier 3 — by barcode found in the description. Applies to all
                // line kinds; the most common use case is a service line whose
                // description still mentions an EAN, e.g. "Service: 8809… cream".
                if (!$matched && $descr !== '' && preg_match('/(?<!\d)(\d{8,14})(?!\d)/', $descr, $m)) {
                    $barcode = $m[1];
                    $cacheKey = 'bc:' . $barcode;
                    if (!array_key_exists($cacheKey, $productCache)) {
                        $bc = $this->em->getRepository(ProductBarcode::class)
                            ->findOneBy(['value' => $barcode]);
                        $productCache[$cacheKey] = $bc?->getProduct();
                    }
                    $matched = $productCache[$cacheKey];
                }

                if ($matched) {
                    $item->setProduct($matched);
                    $linkedToProduct++;
                } elseif ($kind === 'service') {
                    $serviceLines++;
                }

                $sale->addItem($item);
                $this->em->persist($item);

                if (is_numeric($item->getTotalHt()))  { $sumHt  += (float) $item->getTotalHt(); }
                if (is_numeric($item->getTotalTtc())) { $sumTtc += (float) $item->getTotalTtc(); }
            }

            $sale->setTotalHt($sumHt > 0 ? (string) $sumHt : null);
            $sale->setTotalTtc($sumTtc > 0 ? (string) $sumTtc : null);
        }

        $this->em->flush();

        $io->success(sprintf(
            'Done. %d sales created, %d updated, %d duplicate row(s) merged, %d item line(s) linked to a Product, %d service line(s).',
            $created, $updated, $mergedDupes, $linkedToProduct, $serviceLines
        ));

        return Command::SUCCESS;
    }

    private static function numericOrNull(mixed $v): ?string
    {
        if ($v === null || $v === '') return null;
        return is_numeric($v) ? (string) $v : null;
    }

    private static function parseDate(string $raw): ?\DateTimeImmutable
    {
        $raw = trim($raw);
        if ($raw === '') return null;
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
