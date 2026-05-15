<?php

namespace App\Entity;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\GetCollection;
use App\Repository\SaleRepository;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Serializer\Attribute\Groups;

/**
 * A sale (invoice) scraped from Dolibarr's facture/list.php. Each Sale has
 * one or more SaleItem rows. The `reference` column is unique so re-imports
 * are idempotent — the same invoice updates in place rather than being
 * duplicated.
 */
#[ORM\Entity(repositoryClass: SaleRepository::class)]
#[ORM\Table(name: 'sales')]
#[ORM\Index(name: 'idx_sale_reference', columns: ['reference'])]
#[ApiResource(
    normalizationContext: ['groups' => ['sale:read']],
    operations: [
        new GetCollection(),
        new Get(),
    ],
    // Two-key sort so pagination is stable when many sales share a date.
    // Without `id` as a tiebreaker, MySQL can return the same row on two
    // adjacent pages — which is what "pagination not working" usually means
    // for date-heavy tables.
    order: ['date' => 'DESC', 'id' => 'DESC'],
    paginationItemsPerPage: 25,
    // Allow the frontend to override `itemsPerPage` via the query string.
    // API Platform 4 ignores client values for this unless explicitly opted in.
    paginationClientItemsPerPage: true,
)]
class Sale
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    #[Groups(['sale:read'])]
    private ?int $id = null;

    #[ORM\Column(length: 64, unique: true)]
    #[Groups(['sale:read'])]
    private string $reference;

    #[ORM\Column(type: 'date', nullable: true)]
    #[Groups(['sale:read'])]
    private ?\DateTimeInterface $date = null;

    #[ORM\Column(length: 64, nullable: true)]
    #[Groups(['sale:read'])]
    private ?string $rawDate = null;

    #[ORM\Column(length: 512, nullable: true)]
    #[Groups(['sale:read'])]
    private ?string $detailUrl = null;

    /** Sum of item totalHt — pre-computed at import for quick listing display. */
    #[ORM\Column(type: 'decimal', precision: 12, scale: 4, nullable: true)]
    #[Groups(['sale:read'])]
    private ?string $totalHt = null;

    /** Sum of item totalTtc — pre-computed at import. */
    #[ORM\Column(type: 'decimal', precision: 12, scale: 4, nullable: true)]
    #[Groups(['sale:read'])]
    private ?string $totalTtc = null;

    /** @var Collection<int, SaleItem> */
    #[ORM\OneToMany(mappedBy: 'sale', targetEntity: SaleItem::class, cascade: ['persist', 'remove'], orphanRemoval: true)]
    #[Groups(['sale:read'])]
    private Collection $items;

    public function __construct()
    {
        $this->items = new ArrayCollection();
    }

    public function getId(): ?int { return $this->id; }

    public function getReference(): string { return $this->reference; }
    public function setReference(string $r): static { $this->reference = $r; return $this; }

    public function getDate(): ?\DateTimeInterface { return $this->date; }
    public function setDate(?\DateTimeInterface $d): static { $this->date = $d; return $this; }

    public function getRawDate(): ?string { return $this->rawDate; }
    public function setRawDate(?string $d): static { $this->rawDate = $d; return $this; }

    public function getDetailUrl(): ?string { return $this->detailUrl; }
    public function setDetailUrl(?string $u): static { $this->detailUrl = $u; return $this; }

    public function getTotalHt(): ?string { return $this->totalHt; }
    public function setTotalHt(?string $v): static { $this->totalHt = $v; return $this; }

    public function getTotalTtc(): ?string { return $this->totalTtc; }
    public function setTotalTtc(?string $v): static { $this->totalTtc = $v; return $this; }

    /** @return Collection<int, SaleItem> */
    public function getItems(): Collection { return $this->items; }

    public function addItem(SaleItem $it): static
    {
        if (!$this->items->contains($it)) {
            $this->items->add($it);
            $it->setSale($this);
        }
        return $this;
    }

    public function removeItem(SaleItem $it): static
    {
        if ($this->items->removeElement($it) && $it->getSale() === $this) {
            $it->setSale(null);
        }
        return $this;
    }
}
