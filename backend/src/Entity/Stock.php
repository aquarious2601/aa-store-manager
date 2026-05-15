<?php

namespace App\Entity;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Patch;
use ApiPlatform\Metadata\Post;
use App\Repository\StockRepository;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Serializer\Attribute\Groups;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Stock level of a Product at a Branch. The (product, branch) pair is unique:
 * each combination is one row, updated in place when quantity changes.
 */
#[ORM\Entity(repositoryClass: StockRepository::class)]
#[ORM\Table(name: 'stocks')]
#[ORM\UniqueConstraint(name: 'uniq_stock_product_branch', columns: ['product_id', 'branch_id'])]
#[ApiResource(
    normalizationContext: ['groups' => ['stock:read', 'product:read']],
    denormalizationContext: ['groups' => ['stock:write']],
    operations: [
        new GetCollection(),
        new Get(),
        new Post(),
        new Patch(),
        new Delete(),
    ],
)]
class Stock
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    #[Groups(['stock:read', 'product:read'])]
    private ?int $id = null;

    #[ORM\ManyToOne(inversedBy: 'stocks')]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    #[Groups(['stock:read', 'stock:write'])]
    #[Assert\NotNull]
    private ?Product $product = null;

    #[ORM\ManyToOne(inversedBy: 'stocks')]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    #[Groups(['stock:read', 'stock:write', 'product:read'])]
    #[Assert\NotNull]
    private ?Branch $branch = null;

    #[ORM\Column]
    #[Groups(['stock:read', 'stock:write', 'product:read'])]
    #[Assert\PositiveOrZero]
    private int $quantity = 0;

    #[ORM\Column(type: 'datetime_immutable')]
    #[Groups(['stock:read', 'product:read'])]
    private \DateTimeImmutable $updatedAt;

    public function __construct()
    {
        $this->updatedAt = new \DateTimeImmutable();
    }

    public function getId(): ?int { return $this->id; }

    public function getProduct(): ?Product { return $this->product; }
    public function setProduct(?Product $product): static { $this->product = $product; return $this; }

    public function getBranch(): ?Branch { return $this->branch; }
    public function setBranch(?Branch $branch): static { $this->branch = $branch; return $this; }

    public function getQuantity(): int { return $this->quantity; }
    public function setQuantity(int $quantity): static
    {
        $this->quantity = $quantity;
        $this->updatedAt = new \DateTimeImmutable();
        return $this;
    }

    public function getUpdatedAt(): \DateTimeImmutable { return $this->updatedAt; }
}
