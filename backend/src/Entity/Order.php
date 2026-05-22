<?php

namespace App\Entity;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\GetCollection;
use App\Repository\OrderRepository;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Serializer\Attribute\Groups;

#[ORM\Entity(repositoryClass: OrderRepository::class)]
#[ORM\Table(name: '`orders`')]
#[ORM\Index(name: 'idx_order_reference', columns: ['reference'])]
#[ORM\Index(name: 'idx_order_date', columns: ['date'])]
#[ApiResource(
    normalizationContext: ['groups' => ['order:read']],
    operations: [
        new GetCollection(),
        new Get(),
    ],
    order: ['date' => 'DESC'],
    paginationItemsPerPage: 25,
    paginationClientItemsPerPage: true,
)]
class Order
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    #[Groups(['order:read'])]
    private ?int $id = null;

    #[ORM\Column(length: 64, unique: true)]
    #[Groups(['order:read'])]
    private string $reference;

    #[ORM\Column(type: 'date', nullable: true)]
    #[Groups(['order:read'])]
    private ?\DateTimeInterface $date = null;

    #[ORM\Column(length: 64, nullable: true)]
    #[Groups(['order:read'])]
    private ?string $rawDate = null;

    #[ORM\Column(length: 128)]
    #[Groups(['order:read'])]
    private string $status;

    #[ORM\Column(length: 32, nullable: true)]
    #[Groups(['order:read'])]
    private ?string $total = null;

    /**
     * Numeric parse of $total, populated at import. Lets the summary endpoint
     * SUM/GROUP BY in pure SQL instead of fetching every row into PHP just to
     * parse "459,16 €" strings.
     */
    #[ORM\Column(type: 'decimal', precision: 12, scale: 4, nullable: true)]
    #[Groups(['order:read'])]
    private ?string $totalNumeric = null;

    #[ORM\Column(length: 128, nullable: true)]
    #[Groups(['order:read'])]
    private ?string $payment = null;

    #[ORM\Column(length: 512, nullable: true)]
    #[Groups(['order:read'])]
    private ?string $detailUrl = null;

    /** @var Collection<int, OrderItem> */
    #[ORM\OneToMany(mappedBy: 'order', targetEntity: OrderItem::class, cascade: ['persist', 'remove'], orphanRemoval: true)]
    #[Groups(['order:read'])]
    private Collection $items;

    public function __construct()
    {
        $this->items = new ArrayCollection();
    }

    public function getId(): ?int { return $this->id; }

    public function getReference(): string { return $this->reference; }
    public function setReference(string $reference): static { $this->reference = $reference; return $this; }

    public function getDate(): ?\DateTimeInterface { return $this->date; }
    public function setDate(?\DateTimeInterface $date): static { $this->date = $date; return $this; }

    public function getRawDate(): ?string { return $this->rawDate; }
    public function setRawDate(?string $rawDate): static { $this->rawDate = $rawDate; return $this; }

    public function getStatus(): string { return $this->status; }
    public function setStatus(string $status): static { $this->status = $status; return $this; }

    public function getTotal(): ?string { return $this->total; }
    public function setTotal(?string $total): static { $this->total = $total; return $this; }

    public function getTotalNumeric(): ?string { return $this->totalNumeric; }
    public function setTotalNumeric(?string $v): static { $this->totalNumeric = $v; return $this; }

    public function getPayment(): ?string { return $this->payment; }
    public function setPayment(?string $payment): static { $this->payment = $payment; return $this; }

    public function getDetailUrl(): ?string { return $this->detailUrl; }
    public function setDetailUrl(?string $detailUrl): static { $this->detailUrl = $detailUrl; return $this; }

    /** @return Collection<int, OrderItem> */
    public function getItems(): Collection { return $this->items; }

    public function addItem(OrderItem $item): static
    {
        if (!$this->items->contains($item)) {
            $this->items->add($item);
            $item->setOrder($this);
        }
        return $this;
    }

    public function removeItem(OrderItem $item): static
    {
        if ($this->items->removeElement($item) && $item->getOrder() === $this) {
            $item->setOrder(null);
        }
        return $this;
    }
}
