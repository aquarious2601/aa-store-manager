<?php

namespace App\Controller;

use App\Repository\ProductRepository;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Quick product search used by the frontend's "find a product across orders" widget.
 *
 * GET /api/products-search?q=<barcode or name>
 *
 * The endpoint sits at `/api/products-search` (note the hyphen, NOT
 * `/api/products/search`) on purpose: API Platform auto-generates
 * `/api/products/{id}` for the Product resource, and Symfony was matching
 * `search` as an id and returning 404. Keeping the search at its own top-level
 * path avoids the collision entirely.
 *
 * Returns a flat list of products with the order(s) each one appears in,
 * plus a `priceHistory` and aggregate `priceStats` per product.
 */
final class ProductSearchController extends AbstractController
{
    #[Route('/api/products-search', name: 'app_product_search', methods: ['GET'])]
    public function __invoke(Request $request, ProductRepository $products): JsonResponse
    {
        $q = trim((string) $request->query->get('q', ''));
        if ($q === '') {
            return $this->json(['query' => $q, 'results' => []]);
        }

        $found = $products->searchWithOrders($q, limit: 100);

        $results = [];
        foreach ($found as $p) {
            // Orders this product appears in (dedup by order id — a product can
            // legitimately appear twice in one order on different lines, but for
            // the "which orders is this in?" UI we only want to list each once).
            $orders = [];
            foreach ($p->getItems() as $item) {
                $o = $item->getOrder();
                if (!$o) {
                    continue;
                }
                $orders[$o->getId()] = [
                    'id'        => $o->getId(),
                    'reference' => $o->getReference(),
                    'date'      => $o->getDate()?->format('Y-m-d'),
                    'status'    => $o->getStatus(),
                    'quantity'  => $item->getQuantity(),
                ];
            }

            // Full price history (every line on every order, newest first).
            $priceHistory = $p->getPriceHistory();

            // Convenience aggregates the frontend can show without re-walking
            // the list. Prices are kept verbatim as strings (e.g. "10,92 €")
            // so we don't lose currency / formatting info, so the min/max/avg
            // are computed by parsing them once.
            $numeric = [];
            foreach ($priceHistory as $entry) {
                $n = self::parsePrice((string) ($entry['unitPrice'] ?? ''));
                if ($n !== null) {
                    $numeric[] = $n;
                }
            }
            $stats = null;
            if ($numeric) {
                $stats = [
                    'count'   => count($numeric),
                    'min'     => round(min($numeric), 4),
                    'max'     => round(max($numeric), 4),
                    'avg'     => round(array_sum($numeric) / count($numeric), 4),
                    'latest'  => round($numeric[0], 4), // newest-first ordering
                ];
            }

            // Collect all barcodes for this product. The old single-barcode
            // field is gone; barcodes are now a separate one-to-many table.
            $barcodes = [];
            foreach ($p->getBarcodes() as $bc) {
                $barcodes[] = [
                    'id'    => $bc->getId(),
                    'value' => $bc->getValue(),
                    'label' => $bc->getLabel(),
                ];
            }

            $results[] = [
                'id'           => $p->getId(),
                'name'         => $p->getName(),
                'reference'    => $p->getReference(),
                'barcodes'     => $barcodes,
                'orders'       => array_values($orders),
                'priceHistory' => $priceHistory,
                'priceStats'   => $stats,
            ];
        }

        return $this->json(['query' => $q, 'results' => $results]);
    }

    /**
     * Parse a price string ("10,92 €", "10.92 EUR", "  9,17&nbsp;€  ") into a
     * float. Returns null if no number can be extracted.
     */
    private static function parsePrice(string $raw): ?float
    {
        if ($raw === '') {
            return null;
        }
        // Replace non-breaking space, drop currency symbols/letters, convert
        // comma decimal separator to dot.
        $s = str_replace(["\xc2\xa0", "\u{00A0}"], ' ', $raw);
        $s = preg_replace('/[^0-9,.\-]/u', '', $s);
        if ($s === '' || $s === null) {
            return null;
        }
        // If both . and , exist, assume European format "1.234,56" — drop dots, swap comma
        if (str_contains($s, ',') && str_contains($s, '.')) {
            $s = str_replace('.', '', $s);
        }
        $s = str_replace(',', '.', $s);
        return is_numeric($s) ? (float) $s : null;
    }
}
