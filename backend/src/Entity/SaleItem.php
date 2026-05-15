<?php

namespace App\Entity;

use App\Repository\SaleItemRepository;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Serializer\Attribute\Groups;

/**
 * One line on an invoice. May reference an existing Product (if the line was
 * a real product with a known reference) or be a free-text service line
 * (description set, product null).
 */
#[ORM\Entity(repositoryClass: SaleItemRepository::class)]
#[ORM\Table(name: 'sale_items')]
class SaleItem
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    #[Groups(['sale:read'])]
    private ?int $id = null;

    #[ORM\ManyToOne(inversedBy: 'items')]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private ?Sale $sale = null;

    /** Nullable: services don't link to a Product. */
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: true, onDelete: 'SET NULL')]
    #[Groups(['sale:read'])]
    private ?Product $product = null;

    #[ORM\Column(length: 512)]
    #[Groups(['sale:read'])]
    private string $description = '';

    #[ORM\Column(type: 'decimal', precision: 5, scale: 2, nullable: true)]
    #[Groups(['sale:read'])]
    private ?string $vatRate = null;

    #[ORM\Column(type: 'decimal', precision: 12, scale: 4, nullable: true)]
    #[Groups(['sale:read'])]
    private ?string $unitPriceHt = null;

    #[ORM\Column]
    #[Groups(['sale:read'])]
    private int $quantity = 1;

    #[ORM\Column(type: 'decimal', precision: 12, scale: 4, nullable: true)]
    #[Groups(['sale:read'])]
    private ?string $totalHt = null;

    #[ORM\Column(type: 'decimal', precision: 12, scale: 4, nullable: true)]
    #[Groups(['sale:read'])]
    private ?string $totalTtc = null;

    public function getId(): ?int { return $this->id; }

    public function getSale(): ?Sale { return $this->sale; }
    public function setSale(?Sale $s): static { $this->sale = $s; return $this; }

    public function getProduct(): ?Product { return $this->product; }
    public function setProduct(?Product $p): static { $this->product = $p; return $this; }

    public function getDescription(): string { return $this->description; }
    public function setDescription(string $d): static { $this->description = $d; return $this; }

    public function getVatRate(): ?string { return $this->vatRate; }
    public function setVatRate(?string $v): static { $this->vatRate = $v; return $this; }

    public function getUnitPriceHt(): ?string { return $this->unitPriceHt; }
    public function setUnitPriceHt(?string $v): static { $this->unitPriceHt = $v; return $this; }

    public function getQuantity(): int { return $this->quantity; }
    public function setQuantity(int $q): static { $this->quantity = $q; return $this; }

    public function getTotalHt(): ?string { return $this->totalHt; }
    public function setTotalHt(?string $v): static { $this->totalHt = $v; return $this; }

    public function getTotalTtc(): ?string { return $this->totalTtc; }
    public function setTotalTtc(?string $v): static { $this->totalTtc = $v; return $this; }
}
