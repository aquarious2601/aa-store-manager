<?php

namespace App\Controller;

use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/**
 * GET /api/orders-summary[?periods=1]
 *
 * Aggregates orders by status (always) and by week / month (only when
 * ?periods=1). All aggregation happens in SQL via GROUP BY on the indexed
 * columns plus the precomputed `total_numeric` decimal — the database returns
 * a handful of summary rows instead of PHP fetching and looping over every
 * order. This is dramatically faster on large datasets and memory-constrained
 * servers.
 *
 * Requires the `total_numeric` column to be populated (see ImportOrdersCommand
 * and the backfill SQL in deploy notes). Rows where it's NULL contribute to
 * counts but not to the summed amount.
 */
#[AsController]
final class OrdersSummaryController extends AbstractController
{
    #[Route('/api/orders-summary', name: 'app_orders_summary', methods: ['GET'])]
    public function __invoke(Request $request, EntityManagerInterface $em): JsonResponse
    {
        $includePeriods = $request->query->getBoolean('periods', false);
        $conn = $em->getConnection();

        // --- by status (always) -------------------------------------------------
        $statusRows = $conn->fetchAllAssociative(
            'SELECT status,
                    COUNT(*)                       AS count,
                    COALESCE(SUM(total_numeric), 0) AS amount
             FROM orders
             GROUP BY status
             ORDER BY amount DESC, count DESC'
        );
        $byStatus = array_map(static fn ($r) => [
            'status' => $r['status'] ?? '',
            'count'  => (int) $r['count'],
            'amount' => round((float) $r['amount'], 2),
        ], $statusRows);

        // --- grand totals -------------------------------------------------------
        $totals = $conn->fetchAssociative(
            'SELECT COUNT(*) AS total_orders, COALESCE(SUM(total_numeric), 0) AS total_amount
             FROM orders'
        ) ?: ['total_orders' => 0, 'total_amount' => 0];

        $payload = [
            'totalOrders' => (int) $totals['total_orders'],
            'totalAmount' => round((float) $totals['total_amount'], 2),
            'byStatus'    => $byStatus,
        ];

        // --- by week / month (only on request) ----------------------------------
        if ($includePeriods) {
            // ISO week: YEARWEEK(date, 3) gives the ISO-8601 week number with
            // weeks starting Monday. We format the key/label in PHP from the
            // grouped rows below.
            $weekRows = $conn->fetchAllAssociative(
                "SELECT YEARWEEK(date, 3)            AS yw,
                        COUNT(*)                     AS count,
                        COALESCE(SUM(total_numeric), 0) AS amount
                 FROM orders
                 WHERE date IS NOT NULL
                 GROUP BY YEARWEEK(date, 3)
                 ORDER BY yw DESC"
            );
            $byWeek = array_map(static function ($r) {
                $yw = (string) $r['yw'];            // e.g. "202619"
                $year = substr($yw, 0, 4);
                $week = substr($yw, 4);
                return [
                    'period' => "$year-W$week",
                    'label'  => "Week $week ($year)",
                    'count'  => (int) $r['count'],
                    'amount' => round((float) $r['amount'], 2),
                ];
            }, $weekRows);

            $monthRows = $conn->fetchAllAssociative(
                "SELECT DATE_FORMAT(date, '%Y-%m')   AS ym,
                        COUNT(*)                     AS count,
                        COALESCE(SUM(total_numeric), 0) AS amount
                 FROM orders
                 WHERE date IS NOT NULL
                 GROUP BY DATE_FORMAT(date, '%Y-%m')
                 ORDER BY ym DESC"
            );
            $monthLabels = [
                '01' => 'Jan', '02' => 'Feb', '03' => 'Mar', '04' => 'Apr',
                '05' => 'May', '06' => 'Jun', '07' => 'Jul', '08' => 'Aug',
                '09' => 'Sep', '10' => 'Oct', '11' => 'Nov', '12' => 'Dec',
            ];
            $byMonth = array_map(static function ($r) use ($monthLabels) {
                $ym = (string) $r['ym'];            // e.g. "2026-05"
                [$year, $mm] = explode('-', $ym);
                return [
                    'period' => $ym,
                    'label'  => ($monthLabels[$mm] ?? $mm) . ' ' . $year,
                    'count'  => (int) $r['count'],
                    'amount' => round((float) $r['amount'], 2),
                ];
            }, $monthRows);

            $payload['byWeek']  = $byWeek;
            $payload['byMonth'] = $byMonth;
        }

        return $this->json($payload);
    }
}
