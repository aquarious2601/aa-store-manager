<?php

namespace App\Controller;

use App\Entity\Sale;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Serializer\SerializerInterface;

/**
 * GET /api/sales-by-day?page=1&daysPerPage=5
 *
 * Returns sales grouped by date. Pagination unit is the day, NOT the
 * individual sale, so a high-volume day stays whole on one page instead of
 * being split across two. Each day comes back with its summary (count,
 * totals) plus the full list of sales for that day.
 *
 * Route deliberately sits outside `/api/sales/{id}` to avoid the route
 * collision that bit the product search endpoint earlier.
 *
 * Response shape:
 *   {
 *     "page": 1,
 *     "daysPerPage": 5,
 *     "totalDays": 47,
 *     "days": [
 *       {
 *         "day": "2026-05-15",
 *         "saleCount": 12,
 *         "totalHt": "548.20",
 *         "totalTtc": "657.84",
 *         "sales": [ <Sale serialized with sale:read>... ]
 *       },
 *       ...
 *     ]
 *   }
 */
#[AsController]
final class SalesByDayController extends AbstractController
{
    #[Route('/api/sales-by-day', name: 'app_sales_by_day', methods: ['GET'])]
    public function __invoke(
        Request $request,
        EntityManagerInterface $em,
        SerializerInterface $serializer,
    ): JsonResponse {
        $page = max(1, (int) $request->query->get('page', 1));
        $daysPerPage = max(1, min(50, (int) $request->query->get('daysPerPage', 5)));
        $offset = ($page - 1) * $daysPerPage;
        $from = self::normalizeDateParam($request->query->get('from'));
        $to   = self::normalizeDateParam($request->query->get('to'));

        $conn = $em->getConnection();

        // Build the optional WHERE-clause fragment and matching params for both
        // queries so the count and the page agree on the same window.
        $where = 'date IS NOT NULL';
        $params = [];
        if ($from) { $where .= ' AND date >= :from'; $params['from'] = $from; }
        if ($to)   { $where .= ' AND date <= :to';   $params['to']   = $to;   }

        // 1. Count distinct days with at least one dated sale in window.
        $totalDays = (int) $conn->fetchOne(
            "SELECT COUNT(*) FROM (SELECT DISTINCT date FROM sales WHERE $where) AS d",
            $params,
        );

        // 2. The day rows for the current page, newest first.
        $dayRows = $conn->fetchAllAssociative(
            "SELECT date AS day,
                    COUNT(*) AS sale_count,
                    COALESCE(SUM(total_ht), 0)  AS total_ht,
                    COALESCE(SUM(total_ttc), 0) AS total_ttc
             FROM sales
             WHERE $where
             GROUP BY date
             ORDER BY date DESC
             LIMIT " . (int) $daysPerPage . ' OFFSET ' . (int) $offset,
            $params,
        );

        if (empty($dayRows)) {
            return $this->json([
                'page' => $page,
                'daysPerPage' => $daysPerPage,
                'totalDays' => $totalDays,
                'days' => [],
            ]);
        }

        // 3. Fetch every Sale falling on those dates in a single query.
        //    `s.date` is a DATE column; passing strings of the form YYYY-MM-DD
        //    with PARAM_STR_ARRAY lets MySQL do the comparison natively. We
        //    intentionally avoid DateTimeImmutable objects here because the
        //    DBAL Connection layer doesn't auto-stringify them inside an IN().
        $dayKeys = array_map(
            static fn ($r) => substr((string) $r['day'], 0, 10),
            $dayRows,
        );
        $sales = $em->getRepository(Sale::class)->createQueryBuilder('s')
            ->leftJoin('s.items', 'i')->addSelect('i')
            ->leftJoin('i.product', 'p')->addSelect('p')
            ->where('s.date IN (:days)')
            ->setParameter('days', $dayKeys, ArrayParameterType::STRING)
            ->orderBy('s.date', 'DESC')
            ->addOrderBy('s.id', 'DESC')
            ->getQuery()
            ->getResult();

        // 4. Group sales by their day-key (YYYY-MM-DD) for the response
        $salesByDay = [];
        foreach ($sales as $sale) {
            $key = $sale->getDate()?->format('Y-m-d');
            if ($key === null) continue;
            $salesByDay[$key] ??= [];
            $salesByDay[$key][] = $sale;
        }

        // 5. Serialize each day's sales via the existing `sale:read` group
        //    so we get the same shape the React frontend already understands.
        $days = [];
        foreach ($dayRows as $r) {
            // The driver returns the raw DB value — coerce to Y-m-d for the
            // response key (it can come back as "2026-05-15 00:00:00" on
            // some MySQL configurations).
            $key = substr((string) $r['day'], 0, 10);
            $salesData = json_decode(
                $serializer->serialize(
                    $salesByDay[$key] ?? [],
                    'json',
                    ['groups' => ['sale:read']],
                ),
                true,
            );
            $days[] = [
                'day' => $key,
                'saleCount' => (int) $r['sale_count'],
                'totalHt' => (string) $r['total_ht'],
                'totalTtc' => (string) $r['total_ttc'],
                'sales' => $salesData,
            ];
        }

        return $this->json([
            'page' => $page,
            'daysPerPage' => $daysPerPage,
            'totalDays' => $totalDays,
            'from' => $from,
            'to' => $to,
            'days' => $days,
        ]);
    }

    /**
     * Accept "2026-05-15", "2026/05/15", "15/05/2026", etc. and return a
     * canonical Y-m-d string, or null if the value can't be parsed.
     */
    public static function normalizeDateParam(?string $raw): ?string
    {
        $raw = $raw !== null ? trim($raw) : '';
        if ($raw === '') return null;
        foreach (['Y-m-d', 'Y/m/d', 'd/m/Y', 'd-m-Y'] as $fmt) {
            $d = \DateTimeImmutable::createFromFormat($fmt, $raw);
            if ($d !== false) return $d->format('Y-m-d');
        }
        try {
            return (new \DateTimeImmutable($raw))->format('Y-m-d');
        } catch (\Throwable) {
            return null;
        }
    }
}
