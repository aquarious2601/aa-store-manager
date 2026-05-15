<?php

namespace App\Entity;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Patch;
use ApiPlatform\Metadata\Post;
use App\Repository\BranchRepository;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Serializer\Attribute\Groups;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * A physical store branch (the "multiple physical stores" from the original brief).
 * Stock levels are tracked per (Product, Branch) pair via the Stock entity.
 */
#[ORM\Entity(repositoryClass: BranchRepository::class)]
#[ORM\Table(name: 'branches')]
#[ApiResource(
    normalizationContext: ['groups' => ['branch:read']],
    denormalizationContext: ['groups' => ['branch:write']],
    operations: [
        new GetCollection(),
        new Get(),
        new Post(),
        new Patch(),
        new Delete(),
    ],
    order: ['name' => 'ASC'],
)]
class Branch
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    #[Groups(['branch:read', 'stock:read', 'product:read'])]
    private ?int $id = null;

    #[ORM\Column(length: 128, unique: true)]
    #[Groups(['branch:read', 'branch:write', 'stock:read', 'product:read'])]
    #[Assert\NotBlank]
    #[Assert\Length(max: 128)]
    private string $name;

    #[ORM\Column(length: 255, nullable: true)]
    #[Groups(['branch:read', 'branch:write'])]
    private ?string $address = null;

    /** @var Collection<int, Stock> */
    #[ORM\OneToMany(mappedBy: 'branch', targetEntity: Stock::class, cascade: ['remove'])]
    private Collection $stocks;

    public function __construct()
    {
        $this->stocks = new ArrayCollection();
    }

    public function getId(): ?int { return $this->id; }

    public function getName(): string { return $this->name; }
    public function setName(string $name): static { $this->name = $name; return $this; }

    public function getAddress(): ?string { return $this->address; }
    public function setAddress(?string $address): static { $this->address = $address; return $this; }

    /** @return Collection<int, Stock> */
    public function getStocks(): Collection { return $this->stocks; }
}
