<?php

namespace App\Entity;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Patch;
use ApiPlatform\Metadata\Post;
use App\Repository\ProductRepository;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Serializer\Attribute\Groups;

#[ORM\Entity(repositoryClass: ProductRepository::class)]
#[ORM\Table(name: 'products')]
#[ORM\Index(name: 'idx_product_reference', columns: ['reference'])]
#[ORM\Index(name: 'idx_product_name', columns: ['name'])]
#[ApiResource(
    normalizationContext: ['groups' => ['product:read']],
    denormalizationContext: ['groups' => ['product:write']],
    operations: [
        new GetCollection(),
        new Get(),
        new Post(),
        new Patch(),
        new Delete(),
    ],
    order: ['name' => 'ASC'],
    paginationClientItemsPerPage: true,
)]
class Product
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    #[Groups(['product:read', 'order:read', 'sale:read'])]
    private ?int $id = null;

    #[ORM\Column(length: 255)]
    #[Groups(['product:read', 'product:write', 'order:read', 'sale:read'])]
    private string $name;

    /**
     * Internal product reference (SKU). Unique when set, but nullable —
     * MySQL/MariaDB treat each NULL as distinct, so products imported without
     * a reference do not conflict with each other on this constraint.
     */
    #[ORM\Column(length: 64, nullable: true, unique: true)]
    #[Groups(['product:read', 'product:write', 'order:read', 'sale:read'])]
    private ?string $reference = null;

    /**
     * Current selling price including tax (TTC), scraped from the Dolibarr admin.
     * Stored as a decimal string (Doctrine convention) so we don't lose
     * precision to float arithmetic. Display formatting (currency, decimals)
     * happens in the UI. Exposed under `order:read` too, so the order detail
     * page can compute gross margin without a second round trip.
     */
    #[ORM\Column(type: 'decimal', precision: 10, scale: 4, nullable: true)]
    #[Groups(['product:read', 'product:write', 'order:read', 'sale:read'])]
    private ?string $sellingPrice = null;

    /** Timestamp of the last Dolibarr enrichment, useful to spot stale rows. */
    #[ORM\Column(type: 'datetime_immutable', nullable: true)]
    #[Groups(['product:read'])]
    private ?\DateTimeImmutable $enrichedAt = null;

    /** @var Collection<int, ProductBarcode> */
    #[ORM\OneToMany(
        mappedBy: 'product',
        targetEntity: ProductBarcode::class,
        cascade: ['persist', 'remove'],
        orphanRemoval: true,
    )]
    #[Groups(['product:read'])]
    private Collection $barcodes;

    /** @var Collection<int, Stock> */
    #[ORM\OneToMany(
        mappedBy: 'product',
        targetEntity: Stock::class,
        cascade: ['persist', 'remove'],
        orphanRemoval: true,
    )]
    #[Groups(['product:read'])]
    private Collection $stocks;

    /** @var Collection<int, OrderItem> */
    #[ORM\OneToMany(mappedBy: 'product', targetEntity: OrderItem::class)]
    private Collection $items;

    public function __construct()
    {
        $this->barcodes = new ArrayCollection();
        $this->stocks = new ArrayCollection();
        $this->items = new ArrayCollection();
    }

    public function getId(): ?int { return $this->id; }

    public function getName(): string { return $this->name; }
    public function setName(string $name): static { $this->name = $name; return $this; }

    public function getReference(): ?string { return $this->reference; }
    public function setReference(?string $reference): static { $this->reference = $reference; return $this; }

    public function getSellingPrice(): ?string { return $this->sellingPrice; }
    public function setSellingPrice(?string $sellingPrice): static { $this->sellingPrice = $sellingPrice; return $this; }

    public function getEnrichedAt(): ?\DateTimeImmutable { return $this->enrichedAt; }
    public function setEnrichedAt(?\DateTimeImmutable $at): static { $this->enrichedAt = $at; return $this; }

    /** @return Collection<int, ProductBarcode> */
    public function getBarcodes(): Collection { return $this->barcodes; }

    public function addBarcode(ProductBarcode $bc): static
    {
        if (!$this->barcodes->contains($bc)) {
            $this->barcodes->add($bc);
            $bc->setProduct($this);
        }
        return $this;
    }

    public function removeBarcode(ProductBarcode $bc): static
    {
        $this->barcodes->removeElement($bc);
        return $this;
    }

    /** @return Collection<int, Stock> */
    public function getStocks(): Collection { return $this->stocks; }

    /** @return Collection<int, OrderItem> */
    public function getItems(): Collection { return $this->items; }

    /**
     * Full buying-price history for this product, derived from every OrderItem
     * that references it. Returned newest-first.
     *
     * Each entry is:
     *   - orderReference: the human-readable order code (e.g. "URRZMVCFE")
     *   - orderId:        the DB id of the order, so the frontend can link to it
     *   - date:           the order date (ISO yyyy-mm-dd), or null if unknown
     *   - quantity:       how many of this product the order line was for
     *   - unitPrice:      the unit price recorded on that order line (string,
     *                     kept verbatim from the source so "10,92 €" is preserved)
     *   - totalPrice:     the line total
     *
     * @return list<array{
     *     orderReference: string,
     *     orderId: int|null,
     *     date: string|null,
     *     quantity: int,
     *     unitPrice: ?string,
     *     totalPrice: ?string
     * }>
     */
    #[Groups(['product:read'])]
    public function getPriceHistory(): array
    {
        $history = [];
        foreach ($this->items as $item) {
            $order = $item->getOrder();
            if (!$order) {
                continue;
            }
            $history[] = [
                'orderReference' => $order->getReference(),
                'orderId'        => $order->getId(),
                'date'           => $order->getDate()?->format('Y-m-d'),
                'quantity'       => $item->getQuantity(),
                'unitPrice'      => $item->getUnitPrice(),
                'totalPrice'     => $item->getTotalPrice(),
            ];
        }
        // Newest first; orders without a date sink to the bottom
        usort($history, function ($a, $b) {
            return strcmp((string) ($b['date'] ?? ''), (string) ($a['date'] ?? ''));
        });
        return $history;
    }
}
