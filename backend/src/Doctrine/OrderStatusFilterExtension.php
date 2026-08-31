<?php

namespace App\Doctrine;

use ApiPlatform\Doctrine\Orm\Extension\QueryCollectionExtensionInterface;
use ApiPlatform\Doctrine\Orm\Util\QueryNameGeneratorInterface;
use ApiPlatform\Metadata\Operation;
use App\Entity\Order;
use Doctrine\ORM\QueryBuilder;

/**
 * Server-side `?status=…` filter for the Order collection endpoint.
 *
 * Exact match against the order's status (e.g. "Livré" or "Paiement à
 * distance accepté"), case-insensitive. Accepts a comma-separated list to
 * match any of several statuses, e.g. `?status=Livré,Paiement à distance
 * accepté` (URL-encoded) keeps both.
 *
 * Implemented as a Doctrine extension for the same reason as
 * OrderSearchExtension / OrderDateRangeExtension — see ProductSearchExtension
 * for the #[ApiFilter] history.
 */
final class OrderStatusFilterExtension implements QueryCollectionExtensionInterface
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
        $raw = isset($filters['status']) ? trim((string) $filters['status']) : '';
        if ($raw === '') {
            return;
        }

        $statuses = array_values(array_filter(array_map('trim', explode(',', $raw)), static fn ($s) => $s !== ''));
        if (!$statuses) {
            return;
        }

        $rootAlias = $queryBuilder->getRootAliases()[0];
        $param = $queryNameGenerator->generateParameterName('status');
        $queryBuilder->andWhere("LOWER({$rootAlias}.status) IN (:$param)");
        $queryBuilder->setParameter($param, array_map('mb_strtolower', $statuses));
    }
}
