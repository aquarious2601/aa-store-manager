<?php

namespace App\Doctrine;

use ApiPlatform\Doctrine\Orm\Extension\QueryCollectionExtensionInterface;
use ApiPlatform\Doctrine\Orm\Util\QueryNameGeneratorInterface;
use ApiPlatform\Metadata\Operation;
use App\Entity\Order;
use Doctrine\ORM\QueryBuilder;

/**
 * Default ORDER BY for the Order collection endpoint.
 *
 * The `order` attribute on `#[ApiResource]` (date DESC) works for ordered
 * records, but in MySQL `NULL` values sort first in DESC, which means any
 * imported orders whose date couldn't be parsed land at the top of the list.
 *
 * This extension overrides that: rows with a non-null date come first,
 * sorted newest → oldest, and rows without a parseable date sink to the
 * bottom (still tied-broken by id DESC so newer imports sit above older).
 *
 * Users can still override the order with `?order[date]=ASC` etc — the
 * extension only sets the default when no order params are present.
 */
final class OrderDateSortExtension implements QueryCollectionExtensionInterface
{
    public function applyToCollection(
        QueryBuilder $queryBuilder,
        QueryNameGeneratorInterface $queryNameGenerator,
        string $resourceClass,
        ?Operation $operation = null,
        array $context = []
    ): void {
        if ($resourceClass !== Order::class) {
            return;
        }

        // If the request already specifies an order, leave it alone.
        $filters = $context['filters'] ?? [];
        if (!empty($filters['order'])) {
            return;
        }

        $rootAlias = $queryBuilder->getRootAliases()[0];

        // Replace whatever default ORDER BY was applied earlier in the pipeline.
        $queryBuilder->resetDQLPart('orderBy');

        // Doctrine ORM 3.x rejects raw DQL expressions as the first argument
        // to addOrderBy(). The work-around is to compute the "is null?" flag
        // as a HIDDEN selected field (HIDDEN = not returned to the hydrator)
        // and then order by its alias.
        //   0 = row has a date,  1 = row has no date
        // Sorting this column ASC pushes null-dated rows to the bottom.
        $queryBuilder->addSelect(
            "(CASE WHEN {$rootAlias}.date IS NULL THEN 1 ELSE 0 END) AS HIDDEN date_null_first"
        );
        $queryBuilder->addOrderBy('date_null_first', 'ASC');
        $queryBuilder->addOrderBy("{$rootAlias}.date", 'DESC');
        $queryBuilder->addOrderBy("{$rootAlias}.id", 'DESC');
    }
}
