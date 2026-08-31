<?php

namespace App\Doctrine;

use ApiPlatform\Doctrine\Orm\Extension\QueryCollectionExtensionInterface;
use ApiPlatform\Doctrine\Orm\Util\QueryNameGeneratorInterface;
use ApiPlatform\Metadata\Operation;
use App\Entity\Order;
use Doctrine\ORM\QueryBuilder;

/**
 * Server-side `?search=…` filter for the Order collection endpoint.
 *
 * Matches against reference, status, and payment (LIKE %term%). Multiple
 * words in the search term are AND-ed together, same convention as
 * ProductSearchExtension, so typing "livre virement" finds orders whose
 * combined fields contain both words in any field.
 *
 * Implemented as a Doctrine extension for the same reason as
 * ProductSearchExtension — see that class for the #[ApiFilter] history.
 */
final class OrderSearchExtension implements QueryCollectionExtensionInterface
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
        $rootAlias = $queryBuilder->getRootAliases()[0];

        $term = isset($filters['search']) ? trim((string) $filters['search']) : '';
        if ($term === '') {
            return;
        }

        $tokens = preg_split('/\s+/', $term) ?: [];
        $tokens = array_values(array_filter($tokens, static fn ($t) => $t !== ''));

        foreach ($tokens as $i => $token) {
            $param = $queryNameGenerator->generateParameterName("search_$i");
            $like = '%' . $token . '%';
            $queryBuilder->andWhere(
                $queryBuilder->expr()->orX(
                    $queryBuilder->expr()->like("{$rootAlias}.reference", ":$param"),
                    $queryBuilder->expr()->like("{$rootAlias}.status", ":$param"),
                    $queryBuilder->expr()->like("{$rootAlias}.payment", ":$param"),
                ),
            );
            $queryBuilder->setParameter($param, $like);
        }
    }
}
