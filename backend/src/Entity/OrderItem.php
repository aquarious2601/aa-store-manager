<?php

namespace App\Entity;

use App\Repository\OrderItemRepository;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Serializer\Attribute\Groups;

#[ORM\Entity(repositoryClass: OrderItemRepository::class)]
#[ORM\Table(name: 'order_items')]
class OrderItem
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    #[Groups(['order:read', 'product:read'])]
    private ?int $id = null;

    #[ORM\ManyToOne(inversedBy: 'items')]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private ?Order $order = null;

    #[ORM\ManyToOne(inversedBy: 'items')]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    #[Groups(['order:read'])]
    private ?Product $product = null;

    #[ORM\Column]
    #[Groups(['order:read', 'product:read'])]
    private int $quantity = 1;

    #[ORM\Column(length: 32, nullable: true)]
    #[Groups(['order:read', 'product:read'])]
    private ?string $unitPrice = null;

    /**
     * Numeric parse of $unitPrice, kept alongside the verbatim string so we
     * can run numeric comparisons / sort / aggregate in SQL without parsing
     * "10,92 €" inside DQL. Populated by the import command.
     */
    #[ORM\Column(type: 'decimal', precision: 10, scale: 4, nullable: true)]
    #[Groups(['order:read', 'product:read'])]
    private ?string $unitPriceNumeric = null;

    #[ORM\Column(length: 32, nullable: true)]
    #[Groups(['order:read', 'product:read'])]
    private ?string $totalPrice = null;

    public function getId(): ?int { return $this->id; }

    public function getOrder(): ?Order { return $this->order; }
    public function setOrder(?Order $order): static { $this->order = $order; return $this; }

    public function getProduct(): ?Product { return $this->product; }
    public function setProduct(?Product $product): static { $this->product = $product; return $this; }

    public function getQuantity(): int { return $this->quantity; }
    public function setQuantity(int $quantity): static { $this->quantity = $quantity; return $this; }

    public function getUnitPrice(): ?string { return $this->unitPrice; }
    public function setUnitPrice(?string $unitPrice): static { $this->unitPrice = $unitPrice; return $this; }

    public function getUnitPriceNumeric(): ?string { return $this->unitPriceNumeric; }
    public function setUnitPriceNumeric(?string $v): static { $this->unitPriceNumeric = $v; return $this; }

    public function getTotalPrice(): ?string { return $this->totalPrice; }
    public function setTotalPrice(?string $totalPrice): static { $this->totalPrice = $totalPrice; return $this; }
}
