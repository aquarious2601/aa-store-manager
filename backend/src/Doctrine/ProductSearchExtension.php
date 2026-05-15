<?php

namespace App\Doctrine;

use ApiPlatform\Doctrine\Orm\Extension\QueryCollectionExtensionInterface;
use ApiPlatform\Doctrine\Orm\Util\QueryNameGeneratorInterface;
use ApiPlatform\Metadata\Operation;
use App\Entity\Product;
use Doctrine\ORM\QueryBuilder;

/**
 * Server-side `?search=…` filter for the Product collection endpoint.
 *
 * Matches against name (LIKE %term%), reference (LIKE %term%), and the
 * Product's barcode values (LIKE %term% through the one-to-many ProductBarcode
 * table). Multiple words in the search term are AND-ed together so typing
 * "snail cream" finds products whose combined fields contain both words in
 * any field.
 *
 * Implemented as a Doctrine extension instead of an #[ApiFilter] because
 * API Platform 4.x changed the FilterInterface contract and the bundled
 * SearchFilter currently doesn't satisfy it cleanly — see the earlier
 * incident where #[ApiFilter(SearchFilter::class)] crashed cache:clear.
 * Extensions keep working untouched across both versions.
 */
final class ProductSearchExtension implements QueryCollectionExtensionInterface
{
    public function applyToCollection(
        QueryBuilder $queryBuilder,
        QueryNameGeneratorInterface $queryNameGenerator,
        string $resourceClass,
        ?Operation $operation = null,
        array $context = []
    ): void {
        if ($resourceClass !== Product::class) {
            return;
        }

        $filters = $context['filters'] ?? [];
        $rootAlias = $queryBuilder->getRootAliases()[0];

        $term = isset($filters['search']) ? trim((string) $filters['search']) : '';
        $marginMax = isset($filters['marginMax']) ? (float) $filters['marginMax'] : null;

        // ---- Text search across name / reference / barcodes ----
        if ($term !== '') {
            $queryBuilder
                ->leftJoin("{$rootAlias}.barcodes", 'bc_search')
                ->distinct(true);

            $tokens = preg_split('/\s+/', $term) ?: [];
            $tokens = array_values(array_filter($tokens, static fn ($t) => $t !== ''));

            foreach ($tokens as $i => $token) {
                $param = $queryNameGenerator->generateParameterName("search_$i");
                $like = '%' . $token . '%';
                $queryBuilder->andWhere(
                    $queryBuilder->expr()->orX(
                        $queryBuilder->expr()->like("{$rootAlias}.name", ":$param"),
                        $queryBuilder->expr()->like("{$rootAlias}.reference", ":$param"),
                        $queryBuilder->expr()->like('bc_search.value', ":$param"),
                    ),
                );
                $queryBuilder->setParameter($param, $like);
            }
        }

        // ---- Margin threshold filter ----
        // marginMax = 0.30 → keep products where AT LEAST ONE purchase had
        //               margin < 30% (i.e. an unhealthy line we should
        //               investigate). Algebraically:
        //   (selling_ttc/1.2 - unit) / (selling_ttc/1.2) < threshold
        //   ⇔  unit > selling_ttc/1.2 * (1 - threshold)
        // So we only need to find products with selling_price set and at least
        // one OrderItem.unitPriceNumeric exceeding selling_ttc/1.2 * (1-threshold).
        if ($marginMax !== null && $marginMax > 0) {
            $thresholdParam = $queryNameGenerator->generateParameterName('margin_threshold');
            // 1.2 = 1 + VAT (20%). If you change VAT, change this too.
            $queryBuilder->andWhere("{$rootAlias}.sellingPrice IS NOT NULL");
            $queryBuilder->andWhere(
                $queryBuilder->expr()->exists(
                    'SELECT 1 FROM ' . \App\Entity\OrderItem::class . ' oi_margin '
                    . "WHERE oi_margin.product = {$rootAlias} "
                    . 'AND oi_margin.unitPriceNumeric IS NOT NULL '
                    . "AND oi_margin.unitPriceNumeric > ({$rootAlias}.sellingPrice / 1.2) * (1 - :$thresholdParam)"
                )
            );
            $queryBuilder->setParameter($thresholdParam, $marginMax);
        }
    }
}
