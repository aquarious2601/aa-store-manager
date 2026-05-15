<?php

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\Entity\User;
use Symfony\Component\PasswordHasher\Hasher\UserPasswordHasherInterface;

/**
 * API Platform state processor that hashes the User::$plainPassword field
 * before persisting it, so the API can accept `password` in plain text but
 * the database only ever sees the hashed value.
 *
 * @implements ProcessorInterface<User, User|void>
 */
final class UserPasswordHasher implements ProcessorInterface
{
    public function __construct(
        private readonly ProcessorInterface $persistProcessor,
        private readonly UserPasswordHasherInterface $passwordHasher,
    ) {}

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): mixed
    {
        if ($data instanceof User && $data->getPlainPassword()) {
            $hashed = $this->passwordHasher->hashPassword($data, $data->getPlainPassword());
            $data->setPassword($hashed);
            $data->eraseCredentials();
        }
        return $this->persistProcessor->process($data, $operation, $uriVariables, $context);
    }
}
