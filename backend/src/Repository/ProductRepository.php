<?php

namespace App\Repository;

use App\Entity\Product;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<Product>
 */
class ProductRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Product::class);
    }

    /**
     * Find products by barcode (exact match preferred) or name (partial),
     * eager-loading the OrderItems and their Orders so the frontend can
     * show "this product appears in orders X, Y, Z" in a single round trip.
     *
     * Barcodes now live in a separate ProductBarcode table (one product can
     * have many barcodes), so we join through that table when matching.
     *
     * @return Product[]
     */
    public function searchWithOrders(string $term, int $limit = 50): array
    {
        $term = trim($term);
        if ($term === '') {
            return [];
        }

        return $this->createQueryBuilder('p')
            ->leftJoin('p.items', 'it')->addSelect('it')
            ->leftJoin('it.order', 'o')->addSelect('o')
            ->leftJoin('p.barcodes', 'bc')->addSelect('bc')
            ->where('bc.value = :exact')
            ->orWhere('p.reference = :exact')
            ->orWhere('p.name LIKE :like')
            ->orWhere('bc.value LIKE :like')
            ->setParameter('exact', $term)
            ->setParameter('like', '%' . $term . '%')
            ->orderBy('p.name', 'ASC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    public function findOneByReferenceOrName(?string $reference, string $name): ?Product
    {
        $qb = $this->createQueryBuilder('p');
        if ($reference) {
            $qb->where('p.reference = :ref')->setParameter('ref', $reference);
        } else {
            $qb->where('p.name = :name')->setParameter('name', $name);
        }
        return $qb->setMaxResults(1)->getQuery()->getOneOrNullResult();
    }
}
