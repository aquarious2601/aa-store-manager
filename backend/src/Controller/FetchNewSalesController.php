<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Process\Process;
use Symfony\Component\Routing\Attribute\Route;

/**
 * POST /api/fetch-new-sales
 *
 * Mirror of FetchNewOrdersController for the sales pipeline. Runs the Python
 * scraper in SALES_CREATE_ONLY mode, then runs `app:import-sales` on the
 * resulting sales.json. Returns a JSON summary the UI can render.
 *
 * The same caveats apply: long-running synchronous subprocess, no concurrency
 * lock. Fine for single-shop scale.
 */
#[AsController]
final class FetchNewSalesController extends AbstractController
{
    #[Route('/api/fetch-new-sales', name: 'app_fetch_new_sales', methods: ['POST'])]
    public function __invoke(): JsonResponse
    {
        $projectRoot = realpath($this->getParameter('kernel.project_dir') . '/..');
        if ($projectRoot === false) {
            return new JsonResponse(['error' => 'Could not resolve project root.'], 500);
        }
        $scraperDir = $projectRoot . DIRECTORY_SEPARATOR . 'scraper';
        if (!is_dir($scraperDir)) {
            return new JsonResponse(['error' => "Scraper directory not found at $scraperDir"], 500);
        }

        $pythonBin = $_ENV['PYTHON_BIN']
            ?? getenv('PYTHON_BIN')
            ?: (PHP_OS_FAMILY === 'Windows'
                ? $scraperDir . '\\.venv\\Scripts\\python.exe'
                : $scraperDir . '/.venv/bin/python');

        if (!is_file($pythonBin)) {
            return new JsonResponse([
                'error' => "Python interpreter not found at $pythonBin. "
                    . 'Activate the scraper venv (see scraper/README) or set PYTHON_BIN '
                    . 'in backend/.env.local to an absolute path.',
            ], 500);
        }

        // Inherit the full Windows environment for asyncio / Winsock + force
        // UTF-8 stdout so json_encode doesn't choke on French accents.
        $parentEnv = getenv() ?: $_ENV ?: [];
        $childEnv = array_merge($parentEnv, [
            'SALES_CREATE_ONLY' => '1',
            'PYTHONIOENCODING' => 'utf-8',
            'PYTHONUTF8' => '1',
        ]);

        $scrapeProcess = new Process(
            [$pythonBin, 'scrape_sales.py'],
            $scraperDir,
            $childEnv,
        );
        $scrapeProcess->setTimeout(900); // sales pages are bigger; allow 15 min
        $scrapeProcess->run();

        if (!$scrapeProcess->isSuccessful()) {
            return new JsonResponse([
                'phase' => 'scrape',
                'error' => 'Sales scraper exited with code ' . $scrapeProcess->getExitCode(),
                'stdout' => $this->tail($scrapeProcess->getOutput()),
                'stderr' => $this->tail($scrapeProcess->getErrorOutput()),
            ], 500);
        }
        $scrapeStdout = $scrapeProcess->getOutput();

        $consoleBin = $this->getParameter('kernel.project_dir') . DIRECTORY_SEPARATOR . 'bin' . DIRECTORY_SEPARATOR . 'console';
        $jsonPath = $scraperDir . DIRECTORY_SEPARATOR . 'sales.json';

        $importProcess = new Process(
            ['php', $consoleBin, 'app:import-sales', $jsonPath],
            $this->getParameter('kernel.project_dir'),
            $parentEnv,
        );
        $importProcess->setTimeout(600);
        $importProcess->run();

        if (!$importProcess->isSuccessful()) {
            return new JsonResponse([
                'phase' => 'import',
                'error' => 'Sales import exited with code ' . $importProcess->getExitCode(),
                'scrapeStdout' => $this->tail($scrapeStdout),
                'stdout' => $this->tail($importProcess->getOutput()),
                'stderr' => $this->tail($importProcess->getErrorOutput()),
            ], 500);
        }

        // Parse "(N sales total, M new this run, …)" from the scraper output
        $newSales = null;
        $totalSales = null;
        if (preg_match('/\((\d+) sales total, (\d+) new this run/', $scrapeStdout, $m)) {
            $totalSales = (int) $m[1];
            $newSales = (int) $m[2];
        }

        return new JsonResponse([
            'ok' => true,
            'newSales' => $newSales,
            'totalSales' => $totalSales,
            'scrapeStdoutTail' => $this->tail($scrapeStdout),
            'importStdoutTail' => $this->tail($importProcess->getOutput()),
        ]);
    }

    private function tail(string $output, int $bytes = 2048): string
    {
        $trimmed = strlen($output) <= $bytes ? $output : '…' . substr($output, -$bytes);
        if (preg_match('//u', $trimmed)) {
            return $trimmed;
        }
        $converted = @mb_convert_encoding($trimmed, 'UTF-8', 'Windows-1252');
        if ($converted !== false && preg_match('//u', $converted)) {
            return $converted;
        }
        return mb_convert_encoding($trimmed, 'UTF-8', 'UTF-8');
    }
}
