<?php

namespace App\Doctrine;

use ApiPlatform\Doctrine\Orm\Extension\QueryCollectionExtensionInterface;
use ApiPlatform\Doctrine\Orm\Util\QueryNameGeneratorInterface;
use ApiPlatform\Metadata\Operation;
use App\Entity\Order;
use Doctrine\ORM\QueryBuilder;

/**
 * Server-side `?date[after]=YYYY-MM-DD` filter for the Order collection
 * endpoint. Keeps only orders dated on or after the given day (inclusive).
 *
 * Named after API Platform's bundled DateFilter query convention for
 * familiarity, but implemented as a plain extension for the same reason as
 * ProductSearchExtension / OrderSearchExtension — see ProductSearchExtension
 * for the #[ApiFilter] history.
 */
final class OrderDateRangeExtension implements QueryCollectionExtensionInterface
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

        $filters = $context['filters'] ?? [];
        $after = $filters['date']['after'] ?? null;
        if (!$after) {
            return;
        }

        try {
            $date = new \DateTimeImmutable((string) $after);
        } catch (\Exception) {
            return; // unparseable — ignore rather than 500
        }

        $rootAlias = $queryBuilder->getRootAliases()[0];
        $param = $queryNameGenerator->generateParameterName('date_after');
        $queryBuilder->andWhere("{$rootAlias}.date >= :$param");
        $queryBuilder->setParameter($param, $date, 'date');
    }
}
