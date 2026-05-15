<?php

namespace App\Entity;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Patch;
use ApiPlatform\Metadata\Post;
use App\Repository\ProductBarcodeRepository;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Serializer\Attribute\Groups;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * A single barcode value linked to a Product. A product can have many of these
 * (e.g. a barcode for the box, a different barcode for the single unit, the
 * EAN13 used by one supplier vs another, etc.).
 */
#[ORM\Entity(repositoryClass: ProductBarcodeRepository::class)]
#[ORM\Table(name: 'product_barcodes')]
#[ORM\Index(name: 'idx_product_barcode_value', columns: ['value'])]
#[ApiResource(
    normalizationContext: ['groups' => ['barcode:read', 'product:read']],
    denormalizationContext: ['groups' => ['barcode:write']],
    operations: [
        new GetCollection(),
        new Get(),
        new Post(),
        new Patch(),
        new Delete(),
    ],
)]
class ProductBarcode
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    #[Groups(['barcode:read', 'product:read'])]
    private ?int $id = null;

    #[ORM\ManyToOne(inversedBy: 'barcodes')]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    #[Groups(['barcode:read', 'barcode:write'])]
    #[Assert\NotNull]
    private ?Product $product = null;

    #[ORM\Column(length: 64)]
    #[Groups(['barcode:read', 'barcode:write', 'product:read'])]
    #[Assert\NotBlank]
    #[Assert\Length(max: 64)]
    private string $value;

    /** e.g. "EAN13 box", "EAN13 single unit", "supplier-internal" — free text */
    #[ORM\Column(length: 64, nullable: true)]
    #[Groups(['barcode:read', 'barcode:write', 'product:read'])]
    private ?string $label = null;

    public function getId(): ?int { return $this->id; }

    public function getProduct(): ?Product { return $this->product; }
    public function setProduct(?Product $product): static { $this->product = $product; return $this; }

    public function getValue(): string { return $this->value; }
    public function setValue(string $value): static { $this->value = $value; return $this; }

    public function getLabel(): ?string { return $this->label; }
    public function setLabel(?string $label): static { $this->label = $label; return $this; }
}
