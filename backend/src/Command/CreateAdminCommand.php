<?php

namespace App\Command;

use App\Entity\User;
use App\Repository\UserRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;
use Symfony\Component\PasswordHasher\Hasher\UserPasswordHasherInterface;

/**
 * Creates (or resets the password of) an admin user.
 *
 *   php bin/console app:create-admin              # defaults: login/password
 *   php bin/console app:create-admin alice s3cret
 */
#[AsCommand(name: 'app:create-admin', description: 'Create or update an admin user')]
final class CreateAdminCommand extends Command
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly UserRepository $users,
        private readonly UserPasswordHasherInterface $hasher,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->addArgument('login',    InputArgument::OPTIONAL, 'Login', 'login');
        $this->addArgument('password', InputArgument::OPTIONAL, 'Password', 'password');
        $this->addOption('reset',      mode: InputOption::VALUE_NONE, description: 'If user exists, reset their password');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $login = (string) $input->getArgument('login');
        $plain = (string) $input->getArgument('password');

        $user = $this->users->findOneByLogin($login);
        if (!$user) {
            $user = new User();
            $user->setLogin($login);
            $this->em->persist($user);
        } elseif (!$input->getOption('reset')) {
            $io->warning("User '$login' already exists. Use --reset to overwrite the password.");
            return Command::SUCCESS;
        }

        $user->setRoles(['ROLE_ADMIN']);
        $user->setPassword($this->hasher->hashPassword($user, $plain));

        $this->em->flush();
        $io->success("Admin user '$login' is ready (password: '$plain').");
        return Command::SUCCESS;
    }
}
