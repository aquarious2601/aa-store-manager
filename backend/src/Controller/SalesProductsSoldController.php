<?php

namespace App\Controller;

use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/**
 * GET /api/sales-products-sold?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Aggregates every sale-item line in the requested date range and returns
 * one row per (product, description) combination with totals: quantity,
 * total HT, total TTC, and the number of distinct sales the line appeared
 * in. Used by the Sales page's "Get sale products" button.
 *
 * Product lines (those linked to a Product entity) are grouped purely by
 * product id — `description` variations across sales for the same product
 * are folded together. Service lines (no linked Product) are grouped by
 * their description so each distinct service still gets its own row.
 *
 * Route lives outside `/api/sales/{id}` to avoid id-collision (same trick
 * used for `/api/products-search`).
 */
#[AsController]
final class SalesProductsSoldController extends AbstractController
{
    #[Route('/api/sales-products-sold', name: 'app_sales_products_sold', methods: ['GET'])]
    public function __invoke(Request $request, EntityManagerInterface $em): JsonResponse
    {
        $from = SalesByDayController::normalizeDateParam($request->query->get('from'));
        $to   = SalesByDayController::normalizeDateParam($request->query->get('to'));

        $where = 's.date IS NOT NULL';
        $params = [];
        if ($from) { $where .= ' AND s.date >= :from'; $params['from'] = $from; }
        if ($to)   { $where .= ' AND s.date <= :to';   $params['to']   = $to;   }

        // Single aggregating query. Two GROUP BY keys:
        //   - product_id for product lines (description is folded)
        //   - description for service lines (product_id is NULL, so it falls
        //     into a separate bucket per distinct service text)
        // We use CASE around the service-line key so service rows don't pollute
        // each other across products that happen to share a description.
        //
        // The `bp` subquery brings in BUYING-side info per product: the average
        // unit HT across every supplier OrderItem we have, and the unit HT of
        // the most recent order line (by order date, id as tiebreaker). Both
        // are nullable — products we sell but never bought through the tracked
        // supplier won't have buying data.
        $sql = "
            SELECT
                si.product_id                                                 AS product_id,
                p.reference                                                   AS reference,
                p.name                                                        AS product_name,
                CASE WHEN si.product_id IS NULL THEN si.description ELSE NULL END
                                                                              AS service_desc,
                SUM(si.quantity)                                              AS total_qty,
                COALESCE(SUM(si.total_ht), 0)                                 AS total_ht,
                COALESCE(SUM(si.total_ttc), 0)                                AS total_ttc,
                COUNT(DISTINCT si.sale_id)                                    AS sale_count,
                MAX(bp.avg_buy)                                               AS avg_buy,
                MAX(bp.latest_buy)                                            AS latest_buy
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            LEFT JOIN products p ON p.id = si.product_id
            LEFT JOIN (
                SELECT
                    oi.product_id,
                    AVG(oi.unit_price_numeric) AS avg_buy,
                    (
                        SELECT oi2.unit_price_numeric
                        FROM order_items oi2
                        JOIN orders   o2 ON o2.id = oi2.order_id
                        WHERE oi2.product_id = oi.product_id
                          AND oi2.unit_price_numeric IS NOT NULL
                        ORDER BY o2.date DESC, oi2.id DESC
                        LIMIT 1
                    ) AS latest_buy
                FROM order_items oi
                WHERE oi.unit_price_numeric IS NOT NULL
                GROUP BY oi.product_id
            ) bp ON bp.product_id = si.product_id
            WHERE $where
            GROUP BY si.product_id, p.reference, p.name, service_desc
            ORDER BY total_qty DESC, total_ttc DESC, product_name ASC
        ";

        $rows = $em->getConnection()->fetchAllAssociative($sql, $params);

        $results = [];
        $totalQty = 0;
        $totalHt = 0.0;
        $totalTtc = 0.0;
        $totalCost = 0.0;      // sum of (qty × avg_buy) when avg_buy is known
        $totalProfit = 0.0;    // selling HT − buying cost, when both are known

        foreach ($rows as $r) {
            $isService = $r['product_id'] === null;
            $qty       = (int) $r['total_qty'];
            $sellHt    = (float) $r['total_ht'];
            $sellTtc   = (float) $r['total_ttc'];
            $avgBuy    = $r['avg_buy']    !== null ? (float) $r['avg_buy']    : null;
            $latestBuy = $r['latest_buy'] !== null ? (float) $r['latest_buy'] : null;

            // Estimated cost & profit (using average buy as the cost basis).
            // Only computed when we actually have a buying price — otherwise null,
            // so the UI can render "—" instead of misleading zeros.
            $cost = $avgBuy !== null ? $avgBuy * $qty : null;
            $profit = ($cost !== null && $sellHt > 0) ? $sellHt - $cost : null;
            $marginPct = ($profit !== null && $sellHt > 0) ? ($profit / $sellHt) * 100 : null;

            $results[] = [
                'productId'   => $r['product_id'] !== null ? (int) $r['product_id'] : null,
                'reference'   => $r['reference'] ?? null,
                'name'        => $isService ? ($r['service_desc'] ?? '') : ($r['product_name'] ?? ''),
                'isService'   => $isService,
                'quantity'    => $qty,
                'totalHt'     => (string) $sellHt,
                'totalTtc'    => (string) $sellTtc,
                'saleCount'   => (int) $r['sale_count'],
                'avgBuy'      => $avgBuy    !== null ? round($avgBuy, 4)    : null,
                'latestBuy'   => $latestBuy !== null ? round($latestBuy, 4) : null,
                'totalCost'   => $cost      !== null ? round($cost, 2)      : null,
                'totalProfit' => $profit    !== null ? round($profit, 2)    : null,
                'marginPct'   => $marginPct !== null ? round($marginPct, 1) : null,
            ];

            $totalQty += $qty;
            $totalHt  += $sellHt;
            $totalTtc += $sellTtc;
            if ($cost !== null)   { $totalCost   += $cost; }
            if ($profit !== null) { $totalProfit += $profit; }
        }

        return $this->json([
            'from'        => $from,
            'to'          => $to,
            'lineCount'   => count($results),
            'totalQty'    => $totalQty,
            'totalHt'     => round($totalHt, 2),
            'totalTtc'    => round($totalTtc, 2),
            'totalCost'   => round($totalCost, 2),
            'totalProfit' => round($totalProfit, 2),
            'results'     => $results,
        ]);
    }
}
