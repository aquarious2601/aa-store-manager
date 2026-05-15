<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Process\Process;
use Symfony\Component\Routing\Attribute\Route;

/**
 * POST /api/fetch-new-orders
 *
 * One-click pipeline: run the Python scraper in CREATE_ONLY mode, then run
 * the Symfony app:import-orders console command on the resulting orders.json.
 * Returns a small summary the UI can display.
 *
 * Security: requires ROLE_USER (already enforced by the `/api` firewall rule).
 *
 * NOTE: This synchronously invokes a long-running subprocess. For the
 * single-user / small-shop scale this app targets that's fine — a typical
 * incremental run finishes in well under a minute. For multi-tenant or
 * high-frequency usage you'd want to push the work onto Symfony Messenger
 * and poll for status instead.
 */
#[AsController]
final class FetchNewOrdersController extends AbstractController
{
    #[Route('/api/fetch-new-orders', name: 'app_fetch_new_orders', methods: ['POST'])]
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

        // Pick the venv python (which has Playwright + python-dotenv installed).
        // Allow override via env var PYTHON_BIN for flexibility.
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

        // Inherit the FULL parent environment (Windows needs SystemRoot, PATH,
        // TEMP, WINDIR, etc. for Python's asyncio backend to initialise Winsock).
        // Passing only $_ENV here previously caused:
        //   OSError [WinError 10106] The requested service provider could not be
        //   loaded or initialized
        // because the subprocess started with an almost-empty environment.
        //
        // getenv() with no args returns the real process environment regardless
        // of php.ini `variables_order`, which is what we want.
        $parentEnv = getenv() ?: $_ENV ?: [];
        $childEnv = array_merge($parentEnv, [
            'CREATE_ONLY' => '1',
            // Force Python to emit UTF-8 on stdout/stderr. Without this, on
            // Windows Python defaults to CP-1252 and the scraper's log lines
            // (which contain French accents) come back as non-UTF-8 bytes,
            // which then make json_encode fail with
            //   "Malformed UTF-8 characters, possibly incorrectly encoded".
            'PYTHONIOENCODING' => 'utf-8',
            'PYTHONUTF8' => '1',
        ]);

        // ---- 1. Run the scraper in CREATE_ONLY mode ----
        $scrapeProcess = new Process(
            [$pythonBin, 'scrape_orders.py'],
            $scraperDir,
            $childEnv,
        );
        $scrapeProcess->setTimeout(600); // 10 min ceiling — incremental runs are usually <1min
        $scrapeProcess->run();

        if (!$scrapeProcess->isSuccessful()) {
            return new JsonResponse([
                'phase' => 'scrape',
                'error' => 'Scraper exited with code ' . $scrapeProcess->getExitCode(),
                'stdout' => $this->tail($scrapeProcess->getOutput()),
                'stderr' => $this->tail($scrapeProcess->getErrorOutput()),
            ], 500);
        }
        $scrapeStdout = $scrapeProcess->getOutput();

        // ---- 2. Run the import command on the resulting JSON ----
        $consoleBin = $this->getParameter('kernel.project_dir') . DIRECTORY_SEPARATOR . 'bin' . DIRECTORY_SEPARATOR . 'console';
        $jsonPath = $scraperDir . DIRECTORY_SEPARATOR . 'orders.json';

        $importProcess = new Process(
            ['php', $consoleBin, 'app:import-orders', $jsonPath],
            $this->getParameter('kernel.project_dir'),
            $parentEnv, // same inheritance reason as above
        );
        $importProcess->setTimeout(300);
        $importProcess->run();

        if (!$importProcess->isSuccessful()) {
            return new JsonResponse([
                'phase' => 'import',
                'error' => 'Import command exited with code ' . $importProcess->getExitCode(),
                'scrapeStdout' => $this->tail($scrapeStdout),
                'stdout' => $this->tail($importProcess->getOutput()),
                'stderr' => $this->tail($importProcess->getErrorOutput()),
            ], 500);
        }

        // Parse the scraper's final line for the new-order count, e.g.
        //   "Wrote orders.json (352 orders total, 5 new this run, 47 new product lines)"
        $newOrders = null;
        $totalOrders = null;
        if (preg_match('/\((\d+) orders total, (\d+) new this run/', $scrapeStdout, $m)) {
            $totalOrders = (int) $m[1];
            $newOrders = (int) $m[2];
        }

        return new JsonResponse([
            'ok' => true,
            'newOrders' => $newOrders,
            'totalOrders' => $totalOrders,
            'scrapeStdoutTail' => $this->tail($scrapeStdout),
            'importStdoutTail' => $this->tail($importProcess->getOutput()),
        ]);
    }

    /**
     * Return the last ~2 KB of stdout so the UI can show useful context
     * without dumping megabytes. Also sanitises to valid UTF-8: if PYTHONUTF8
     * doesn't take effect for some reason (e.g. older Python, antivirus
     * intercepting stdout), the bytes we receive can be CP-1252; without
     * sanitising, json_encode aborts with "Malformed UTF-8 characters".
     */
    private function tail(string $output, int $bytes = 2048): string
    {
        $trimmed = strlen($output) <= $bytes ? $output : '…' . substr($output, -$bytes);

        // Cheap UTF-8 validity check; if it's already clean, return as-is.
        if (preg_match('//u', $trimmed)) {
            return $trimmed;
        }

        // Try interpreting the bytes as Windows-1252 (the usual culprit on
        // Windows consoles). If that fails too, fall back to a forgiving
        // replacement of any invalid byte.
        $converted = @mb_convert_encoding($trimmed, 'UTF-8', 'Windows-1252');
        if ($converted !== false && preg_match('//u', $converted)) {
            return $converted;
        }
        return mb_convert_encoding($trimmed, 'UTF-8', 'UTF-8');
    }
}
