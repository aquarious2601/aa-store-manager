<?php

namespace App\Command;

use App\Entity\ProductBarcode;
use App\Repository\ProductBarcodeRepository;
use App\Repository\ProductRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Imports the JSON produced by scrape_product_details.py.
 *
 * For each entry, matches an existing Product by reference and:
 *   - updates `name` only if it's currently empty (we don't want Dolibarr to
 *     clobber a name the user manually corrected)
 *   - sets `sellingPrice` and `enrichedAt`
 *   - adds the scraped barcode to the Product's ProductBarcode collection
 *     IF that exact value isn't already present (no duplicates)
 *
 * Products in the JSON whose reference doesn't match any Product in the DB
 * are reported but not created — they're tracked in the "missing in DB" tally.
 */
#[AsCommand(name: 'app:import-product-details', description: 'Import barcodes + selling prices scraped from the Dolibarr admin')]
final class ImportProductDetailsCommand extends Command
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly ProductRepository $products,
        private readonly ProductBarcodeRepository $barcodes,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->addArgument('file', InputArgument::REQUIRED, 'Path to product_details.json');
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
        $rows = $payload['products'] ?? [];
        $io->title(sprintf('Importing %d product details from %s', count($rows), $path));

        $now = new \DateTimeImmutable();
        $updated = 0;
        $missingInDb = [];
        $barcodesAdded = 0;
        $pricesSet = 0;

        foreach ($rows as $r) {
            $ref = trim((string) ($r['reference'] ?? ''));
            if ($ref === '') {
                continue;
            }

            $product = $this->products->findOneBy(['reference' => $ref]);
            if (!$product) {
                $missingInDb[] = $ref;
                continue;
            }

            // Selling price (decimal string)
            $price = $r['selling_price'] ?? null;
            if ($price !== null && $price !== '') {
                $product->setSellingPrice((string) $price);
                $pricesSet++;
            }

            // Backfill name only if we don't already have one
            $name = trim((string) ($r['name'] ?? ''));
            if ($name !== '' && !$product->getName()) {
                $product->setName($name);
            }

            // Barcode (skip if empty or already attached)
            $bcValue = trim((string) ($r['barcode'] ?? ''));
            if ($bcValue !== '') {
                $exists = false;
                foreach ($product->getBarcodes() as $bc) {
                    if ($bc->getValue() === $bcValue) {
                        $exists = true;
                        break;
                    }
                }
                if (!$exists) {
                    $bc = new ProductBarcode();
                    $bc->setProduct($product);
                    $bc->setValue($bcValue);
                    $bc->setLabel('Dolibarr');
                    $this->em->persist($bc);
                    $product->addBarcode($bc);
                    $barcodesAdded++;
                }
            }

            $product->setEnrichedAt($now);
            $updated++;
        }

        $this->em->flush();

        $io->success(sprintf(
            'Done. %d product(s) updated, %d barcode(s) added, %d selling price(s) set, %d reference(s) had no matching Product in DB.',
            $updated, $barcodesAdded, $pricesSet, count($missingInDb)
        ));
        if ($missingInDb) {
            $io->section('References present in JSON but not in DB (first 20):');
            $io->listing(array_slice($missingInDb, 0, 20));
        }

        return Command::SUCCESS;
    }
}
