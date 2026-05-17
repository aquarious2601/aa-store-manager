<?php

namespace App\Controller;

use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/**
 * GET /api/orders-summary
 *
 * Aggregates orders by status. For each distinct status returns the order
 * count and the summed monetary total. The `total` column on Order is stored
 * as a verbatim French-formatted string ("459,16 €"), so we can't SUM() it in
 * SQL — we parse each row in PHP into a float and sum there.
 *
 * Response:
 *   {
 *     "totalOrders": 372,
 *     "totalAmount": 184523.50,
 *     "byStatus": [
 *       { "status": "Paiement à distance accepté", "count": 348, "amount": 173892.10 },
 *       { "status": "livré",                       "count": 24,  "amount": 10631.40 },
 *       ...
 *     ]
 *   }
 */
#[AsController]
final class OrdersSummaryController extends AbstractController
{
    #[Route('/api/orders-summary', name: 'app_orders_summary', methods: ['GET'])]
    public function __invoke(EntityManagerInterface $em): JsonResponse
    {
        $conn = $em->getConnection();

        // SQL can group + count, but the totals are stored as varchar — so
        // we pull (status, date, total) once and aggregate in PHP. With
        // single-shop volumes (<10k orders) this is comfortably fast.
        $rows = $conn->fetchAllAssociative(
            'SELECT status, date, total
             FROM orders'
        );

        $byStatus = [];   // status      => { status, count, amount }
        $byWeek   = [];   // "2026-W19"  => { period, label, count, amount }
        $byMonth  = [];   // "2026-05"   => { period, label, count, amount }
        $totalOrders = 0;
        $totalAmount = 0.0;

        // Cached month-name lookup for the label (en-FR style: May 2026)
        $monthLabels = [
            1 => 'Jan', 2 => 'Feb', 3 => 'Mar', 4 => 'Apr', 5 => 'May', 6 => 'Jun',
            7 => 'Jul', 8 => 'Aug', 9 => 'Sep', 10 => 'Oct', 11 => 'Nov', 12 => 'Dec',
        ];

        foreach ($rows as $r) {
            $status = $r['status'] ?? '';
            $amount = self::parsePrice((string) ($r['total'] ?? ''));

            // --- by status ----------------------------------------------------
            if (!isset($byStatus[$status])) {
                $byStatus[$status] = ['status' => $status, 'count' => 0, 'amount' => 0.0];
            }
            $byStatus[$status]['count']++;
            if ($amount !== null) {
                $byStatus[$status]['amount'] += $amount;
                $totalAmount += $amount;
            }
            $totalOrders++;

            // --- by week / month ---------------------------------------------
            // Only orders with a parsable date contribute to the time buckets.
            $rawDate = $r['date'] ?? null;
            if ($rawDate) {
                try {
                    $d = new \DateTimeImmutable((string) $rawDate);
                } catch (\Throwable) {
                    $d = null;
                }
                if ($d !== null) {
                    // ISO 8601 week ("o" = ISO year for that week, "W" = week #)
                    $weekKey = $d->format('o-\WW');           // e.g. "2026-W19"
                    $weekLbl = 'Week ' . $d->format('W') . ' (' . $d->format('o') . ')';
                    if (!isset($byWeek[$weekKey])) {
                        $byWeek[$weekKey] = ['period' => $weekKey, 'label' => $weekLbl, 'count' => 0, 'amount' => 0.0];
                    }
                    $byWeek[$weekKey]['count']++;
                    if ($amount !== null) $byWeek[$weekKey]['amount'] += $amount;

                    $monthKey = $d->format('Y-m');             // e.g. "2026-05"
                    $monthLbl = $monthLabels[(int) $d->format('n')] . ' ' . $d->format('Y');
                    if (!isset($byMonth[$monthKey])) {
                        $byMonth[$monthKey] = ['period' => $monthKey, 'label' => $monthLbl, 'count' => 0, 'amount' => 0.0];
                    }
                    $byMonth[$monthKey]['count']++;
                    if ($amount !== null) $byMonth[$monthKey]['amount'] += $amount;
                }
            }
        }

        // Sort: status by amount DESC; week/month by period DESC (newest first)
        usort($byStatus, fn ($a, $b) => $b['amount'] <=> $a['amount'] ?: $b['count'] <=> $a['count']);
        krsort($byWeek);   // string compare on "2026-W19" works because the format is zero-padded
        krsort($byMonth);

        foreach ($byStatus as &$b) { $b['amount'] = round($b['amount'], 2); } unset($b);
        foreach ($byWeek   as &$b) { $b['amount'] = round($b['amount'], 2); } unset($b);
        foreach ($byMonth  as &$b) { $b['amount'] = round($b['amount'], 2); } unset($b);

        return $this->json([
            'totalOrders' => $totalOrders,
            'totalAmount' => round($totalAmount, 2),
            'byStatus'    => array_values($byStatus),
            'byWeek'      => array_values($byWeek),
            'byMonth'     => array_values($byMonth),
        ]);
    }

    /** "459,16 €" / "1 234,56 €" → 459.16 / 1234.56. Null if no number. */
    private static function parsePrice(string $raw): ?float
    {
        if ($raw === '') return null;
        $s = str_replace(["\xc2\xa0", ' '], '', $raw);
        $s = preg_replace('/[^0-9,.\-]/u', '', $s);
        if ($s === '' || $s === null) return null;
        if (str_contains($s, ',') && str_contains($s, '.')) {
            $s = str_replace('.', '', $s); // European thousands
        }
        $s = str_replace(',', '.', $s);
        return is_numeric($s) ? (float) $s : null;
    }
}
