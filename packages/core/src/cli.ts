#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import { Command } from 'commander'
import Table from 'cli-table3'
import ora from 'ora'
import qrcode from 'qrcode-terminal'
import { ConfigError, loadConfig } from './config.js'
import {
  buildEvalReport,
  computeScoreStability,
  emptyStabilityReport,
  renderMarkdown as renderEvalMarkdown,
} from './eval/index.js'
import { ShelfEventEmitter } from './events/emitter.js'
import type { ShelfEvent } from './events/emitter.js'
import { JsonlLogger } from './logger/jsonl.js'
import { loadFixtureProducts, runLoop } from './loop.js'
import { QueryGenerator } from './queries/generator.js'
import { buildProviders, measureScore } from './scorer/index.js'
import { ShopifyAdminClient } from './shopify/admin.js'
import type { ShopifyProduct } from './shopify/types.js'
import { FileCache } from './utils/cache.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'),
) as { version: string }

const program = new Command()

program
  .name('shelf-ai')
  .description(
    'Autoresearch loop for Shopify catalogs — raise how often AI shopping agents surface your products.',
  )
  .version(pkg.version)

program
  .command('qr')
  .description('Print a terminal QR code linking to the shelf GitHub repo (demo aid).')
  .action(() => {
    printQrBanner()
  })

program
  .command('init')
  .description('Create a .env file by prompting for Shopify credentials and provider API keys.')
  .option('-f, --force', 'Overwrite existing .env', false)
  .action(async (options: { force: boolean }) => {
    const envPath = resolve(process.cwd(), '.env')
    if (existsSync(envPath) && !options.force) {
      console.log(chalk.yellow('! .env already exists — re-run with --force to overwrite.'))
      return
    }
    const rl = createInterface({ input: stdin, output: stdout })
    const ask = async (prompt: string, fallback = ''): Promise<string> => {
      const answer = (await rl.question(chalk.cyan(prompt))).trim()
      return answer || fallback
    }
    const askValidated = async (
      prompt: string,
      validate: (raw: string) => string | null,
      opts: { required: boolean } = { required: true },
    ): Promise<string> => {
      for (;;) {
        const raw = (await rl.question(chalk.cyan(prompt))).trim()
        if (!raw) {
          if (!opts.required) return ''
          console.log(chalk.yellow('  ! required — please enter a value.'))
          continue
        }
        const err = validate(raw)
        if (err) {
          console.log(chalk.yellow(`  ! ${err}`))
          continue
        }
        return raw
      }
    }
    console.log(chalk.bold('\nshelf-ai init\n'))
    const domain = await askValidated(
      'Shopify store domain (e.g. my-shop.myshopify.com): ',
      (raw) => {
        const stripped = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
        return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(stripped)
          ? null
          : 'expected a *.myshopify.com domain'
      },
    ).then((raw) => raw.replace(/^https?:\/\//i, '').replace(/\/+$/, ''))
    console.log(
      chalk.dim(
        '\nFor Admin API auth, prefer OAuth client credentials (auto-refreshing 24h tokens).\nLeave both blank to fall back to a long-lived SHOPIFY_ADMIN_ACCESS_TOKEN.\n',
      ),
    )
    const clientId = await ask('Shopify OAuth client ID (enter to skip): ')
    const clientSecret = clientId ? await ask('Shopify OAuth client secret: ') : ''
    const adminToken = clientId
      ? ''
      : await askValidated(
          'Shopify Admin API access token (shpat_… or shpss_…): ',
          (raw) =>
            /^shp(at|ss)_[a-z0-9]+$/i.test(raw)
              ? null
              : 'expected a token starting with shpat_ or shpss_',
          { required: false },
        )
    console.log(chalk.dim('\nAt least one scoring provider key is required.\n'))
    const perplexity = await ask('Perplexity API key (enter to skip): ')
    const openai = await ask('OpenAI API key (enter to skip): ')
    const anthropic = await askValidated(
      'Anthropic API key (required for hypothesis + query generation): ',
      (raw) =>
        raw.startsWith('sk-ant-') ? null : 'expected an Anthropic key starting with sk-ant-',
    )
    rl.close()

    const lines = [`SHOPIFY_STORE_DOMAIN=${domain}`]
    if (clientId) {
      lines.push(`SHOPIFY_CLIENT_ID=${clientId}`)
      lines.push(`SHOPIFY_CLIENT_SECRET=${clientSecret}`)
    }
    if (adminToken) {
      lines.push(`SHOPIFY_ADMIN_ACCESS_TOKEN=${adminToken}`)
    }
    if (perplexity) lines.push(`PERPLEXITY_API_KEY=${perplexity}`)
    if (openai) lines.push(`OPENAI_API_KEY=${openai}`)
    if (anthropic) lines.push(`ANTHROPIC_API_KEY=${anthropic}`)
    writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8')
    console.log(chalk.green(`\n✓ wrote ${envPath}`))
  })

program
  .command('run')
  .description('Run the autoresearch loop: generate hypotheses, apply, re-measure, keep or revert.')
  .option('--dry-run', 'Mock all external API calls (Anthropic, Perplexity, OpenAI) — zero cost, no writes', false)
  .option('--no-shopify', 'With --dry-run, also skip Shopify Admin API calls (use fixture products)', false)
  .option('--max-iterations <n>', 'Override maxIterations from config', parseIntArg)
  .option('--budget <usd>', 'Override budget limit in USD', parseFloatArg)
  .option('--repetitions <n>', 'Queries repetitions per measurement', parseIntArg)
  .option('--delay <ms>', 'Artificial delay between iterations in ms (demo/recording aid)', parseIntArg, 0)
  .option('--fake-elapsed', 'Multiply displayed elapsed time by 60 (requires --dry-run; demo aid)', false)
  .option('--loop', 'After the run completes, automatically restart (demo aid — Ctrl+C to stop)', false)
  .option('--store-category <label>', 'Category hint for hypothesis + query generation')
  .action(
    async (options: {
      dryRun: boolean
      shopify: boolean
      maxIterations?: number
      budget?: number
      repetitions?: number
      delay: number
      fakeElapsed: boolean
      loop: boolean
      storeCategory?: string
    }) => {
      const noShopify = options.shopify === false
      if (noShopify && !options.dryRun) {
        console.error(chalk.red('✗ --no-shopify requires --dry-run (we only skip real Shopify in dry-run).'))
        process.exitCode = 1
        return
      }
      if (options.fakeElapsed && !options.dryRun) {
        console.error(chalk.red('✗ --fake-elapsed requires --dry-run (demo-only aid).'))
        process.exitCode = 1
        return
      }
      const elapsedMultiplier = options.fakeElapsed ? 60 : 1
      process.env.SHELF_ELAPSED_MULTIPLIER = String(elapsedMultiplier)
      writeElapsedSidecar(elapsedMultiplier)
      const config = safeLoadConfig({
        dryRun: options.dryRun,
        noShopify,
        maxIterations: options.maxIterations,
        budgetLimitUsd: options.budget,
        queriesPerMeasurement: options.repetitions,
      })
      printQrBanner()
      const emitter = new ShelfEventEmitter()
      emitter.onAny(renderEvent)
      console.log(chalk.bold.cyan('\n🛒 shelf run\n'))
      try {
        do {
          const final = await runLoop(config, emitter, {
            storeCategory: options.storeCategory,
            iterationDelayMs: options.delay,
          })
          console.log(
            chalk.bold(
              `\nDone. Final score: ${final.currentScore.toFixed(1)}  (baseline ${final.baselineScore.toFixed(1)}, Δ ${(final.currentScore - final.baselineScore).toFixed(1)})`,
            ),
          )
          console.log(chalk.dim(`Session file: ${config.paths.sessionFile}`))
          console.log(chalk.dim(`Experiment log: ${config.paths.logFile}`))
          if (options.loop) {
            console.log(chalk.bold.yellow('\n🔄 Loop complete. Restarting in 3s...\n'))
            await new Promise((r) => setTimeout(r, 3000))
          }
        } while (options.loop)
      } catch (err) {
        console.error(chalk.red(`\n✗ run failed: ${errorMessage(err)}`))
        process.exitCode = 1
      }
    },
  )

program
  .command('score')
  .description('Run a one-shot baseline measurement against the current catalog without modifying anything.')
  .option('--dry-run', 'Mock all external API calls (Anthropic, Perplexity, OpenAI) — zero cost, no writes', false)
  .option('--no-shopify', 'With --dry-run, also skip Shopify Admin API calls (use fixture products)', false)
  .option('--repetitions <n>', 'Queries repetitions per measurement', parseIntArg)
  .option('--query-count <n>', 'Number of queries to generate', parseIntArg, 50)
  .option('--store-category <label>', 'Category hint for query generation')
  .action(
    async (options: {
      dryRun: boolean
      shopify: boolean
      repetitions?: number
      queryCount: number
      storeCategory?: string
    }) => {
      const noShopify = options.shopify === false
      if (noShopify && !options.dryRun) {
        console.error(chalk.red('✗ --no-shopify requires --dry-run (we only skip real Shopify in dry-run).'))
        process.exitCode = 1
        return
      }
      const config = safeLoadConfig({
        dryRun: options.dryRun,
        noShopify,
        queriesPerMeasurement: options.repetitions,
      })
      const anthropicKey = config.providers.anthropic?.apiKey
      if (!config.dryRun && !anthropicKey) {
        console.error(chalk.red('✗ ANTHROPIC_API_KEY required to generate queries.'))
        process.exitCode = 1
        return
      }
      const cache = new FileCache()
      const providers = buildProviders(config, { cache, dryRun: config.dryRun })
      if (providers.length === 0) {
        console.error(chalk.red('✗ no scoring providers configured.'))
        process.exitCode = 1
        return
      }

      let products: ShopifyProduct[]
      if (noShopify) {
        products = loadFixtureProducts()
        console.log(chalk.dim(`  → loaded ${products.length} fixture products (--no-shopify)`))
      } else {
        const adminSpin = ora('Authenticating with Shopify Admin API').start()
        let admin
        try {
          admin = await ShopifyAdminClient.create({
            storeDomain: config.store.domain,
            accessToken: config.store.adminAccessToken,
            clientId: config.store.clientId,
            clientSecret: config.store.clientSecret,
          })
          adminSpin.succeed('Authenticated')
        } catch (err) {
          adminSpin.fail(`Auth failed: ${errorMessage(err)}`)
          process.exitCode = 1
          return
        }
        const fetchSpin = ora('Fetching products from Shopify Admin API').start()
        try {
          products = await admin.listProducts()
          fetchSpin.succeed(`Fetched ${products.length} products`)
        } catch (err) {
          fetchSpin.fail(`Failed to fetch products: ${errorMessage(err)}`)
          process.exitCode = 1
          return
        }
      }

      const querySpin = ora(`Generating ${options.queryCount} queries`).start()
      let queries
      try {
        const generator = new QueryGenerator({ apiKey: anthropicKey, dryRun: config.dryRun })
        queries = await generator.generate({
          products,
          count: options.queryCount,
          storeCategory: options.storeCategory,
        })
        querySpin.succeed(`Generated ${queries.length} queries`)
      } catch (err) {
        querySpin.fail(`Query generation failed: ${errorMessage(err)}`)
        process.exitCode = 1
        return
      }

      const scoreSpin = ora('Measuring AI Shelf Score (this can take a few minutes)').start()
      try {
        const result = await measureScore(queries, config.store.domain, providers, {
          repetitions: config.loop.queriesPerMeasurement,
        })
        scoreSpin.succeed(`Baseline score: ${result.overall.toFixed(1)}/100`)
        const table = new Table({
          head: [chalk.bold('provider'), chalk.bold('score')],
          colWidths: [18, 12],
        })
        for (const [name, score] of Object.entries(result.byProvider)) {
          table.push([name, `${score.toFixed(1)}`])
        }
        console.log(table.toString())
        console.log(
          chalk.dim(
            `queries: ${result.queriesMatched}/${result.queriesTotal} surfaced · cost: $${result.totalCostUsd.toFixed(4)}`,
          ),
        )
      } catch (err) {
        scoreSpin.fail(`Measurement failed: ${errorMessage(err)}`)
        process.exitCode = 1
      }
    },
  )

program
  .command('eval')
  .description('Meta-evaluation of the optimization loop: hypothesis effectiveness, score stability, plateau detection, provider disagreement, reward hacking audit.')
  .option('--live', 'Also run a live re-measurement pass to compute score-stability variance (requires API keys + Shopify access).', false)
  .option('--json', 'Emit the full report as JSON to stdout instead of the human-readable terminal output.', false)
  .option('-o, --out <path>', 'Markdown output path', 'shelf-eval.md')
  .option('--products <n>', 'Number of products to sample for --live stability', parseIntArg, 5)
  .option('--runs <n>', 'Repeat measurements per product for --live stability', parseIntArg, 5)
  .option('--store-category <label>', 'Category hint for --live query generation')
  .action(
    async (options: {
      live: boolean
      json: boolean
      out: string
      products: number
      runs: number
      storeCategory?: string
    }) => {
      const config = safeLoadConfig({})
      const jsonl = new JsonlLogger(config.paths.logFile)
      const logs = jsonl.readAll()
      if (logs.length === 0) {
        console.error(chalk.red(`✗ no experiments found in ${config.paths.logFile}.`))
        console.error(chalk.dim('  run `shelf-ai run` (or `--dry-run --no-shopify`) to populate the log first.'))
        process.exitCode = 1
        return
      }

      let stability = emptyStabilityReport(
        'Run with --live to measure score stability (requires API keys).',
      )
      if (options.live) {
        try {
          stability = await runLiveStability(config, options)
        } catch (err) {
          stability = emptyStabilityReport(
            `--live stability failed: ${errorMessage(err)}`,
          )
        }
      }

      const report = buildEvalReport({
        logs,
        storeDomain: config.store.domain,
        jsonlPath: jsonl.filePath,
        scoreStability: stability,
      })

      if (options.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      } else {
        renderEvalToTerminal(report)
      }

      const outPath = resolve(process.cwd(), options.out)
      writeFileSync(outPath, renderEvalMarkdown(report), 'utf-8')
      if (!options.json) {
        console.log(chalk.dim(`\n✓ wrote ${outPath}`))
      } else {
        console.error(chalk.dim(`✓ wrote ${outPath}`))
      }
    },
  )

program
  .command('dashboard')
  .description('Launch the Next.js dashboard that tails shelf.jsonl in real time.')
  .option('-p, --port <port>', 'Port to bind', '3000')
  .action((options: { port: string }) => {
    const args = ['--filter', '@shelf/dashboard', 'exec', 'next', 'dev', '--port', options.port]
    const child = spawn('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('exit', (code) => {
      process.exitCode = code ?? 0
    })
    child.on('error', (err) => {
      console.error(chalk.red(`✗ failed to start dashboard: ${err.message}`))
      console.error(chalk.dim('  ensure pnpm is installed and the dashboard package exists.'))
      process.exitCode = 1
    })
  })

program
  .command('reset')
  .description('Delete shelf.jsonl, shelf.md, and .shelf-cache/ so the next run starts fresh.')
  .option('-y, --yes', 'Skip confirmation prompt', false)
  .action(async (options: { yes: boolean }) => {
    const config = safeLoadConfig({})
    const logPath = resolve(process.cwd(), config.paths.logFile)
    const sessionPath = resolve(process.cwd(), config.paths.sessionFile)
    const cacheDir = resolve(process.cwd(), '.shelf-cache')
    const files = [logPath, sessionPath].filter(existsSync)
    const cacheExists = existsSync(cacheDir)
    if (files.length === 0 && !cacheExists) {
      console.log(chalk.dim('Nothing to reset — no shelf files or cache found.'))
      return
    }
    const totalTargets = files.length + (cacheExists ? 1 : 0)
    if (!options.yes) {
      const rl = createInterface({ input: stdin, output: stdout })
      const confirm = (
        await rl.question(chalk.yellow(`Delete ${totalTargets} target(s)? [y/N] `))
      ).trim()
      rl.close()
      if (confirm.toLowerCase() !== 'y') {
        console.log(chalk.dim('aborted.'))
        return
      }
    }
    for (const p of files) {
      unlinkSync(p)
      console.log(chalk.green(`✓ removed ${p}`))
    }
    if (cacheExists) {
      rmSync(cacheDir, { recursive: true, force: true })
      console.log(chalk.green(`✓ removed ${cacheDir}`))
    }
  })

program
  .command('export')
  .description('Export shelf.jsonl to CSV or JSON.')
  .argument('[format]', 'csv | json', 'csv')
  .option('-o, --out <path>', 'Output file (default stdout)')
  .action((format: string, options: { out?: string }) => {
    const config = safeLoadConfig({})
    const jsonl = new JsonlLogger(config.paths.logFile)
    const logs = jsonl.readAll()
    if (logs.length === 0) {
      console.error(chalk.dim('No experiments logged yet.'))
      return
    }
    let output: string
    if (format === 'json') {
      output = JSON.stringify(logs, null, 2)
    } else if (format === 'csv') {
      const header = [
        'id',
        'iteration',
        'timestamp',
        'productId',
        'hypothesisType',
        'verdict',
        'scoreBefore',
        'scoreAfter',
        'scoreDelta',
        'confidence',
        'confidenceLevel',
        'durationMs',
        'costEstimateUsd',
      ]
      const rows = logs.map((l) =>
        [
          l.id,
          l.iteration,
          l.timestamp,
          l.hypothesis.productId,
          l.hypothesis.type,
          l.verdict,
          l.scoreBefore.toFixed(3),
          l.scoreAfter.toFixed(3),
          l.scoreDelta.toFixed(3),
          l.confidence,
          l.confidenceLevel,
          l.durationMs,
          l.costEstimateUsd.toFixed(6),
        ]
          .map(csvCell)
          .join(','),
      )
      output = [header.join(','), ...rows].join('\n') + '\n'
    } else {
      console.error(chalk.red(`✗ unknown format: ${format} (expected csv or json)`))
      process.exitCode = 1
      return
    }
    if (options.out) {
      writeFileSync(resolve(process.cwd(), options.out), output, 'utf-8')
      console.error(chalk.green(`✓ wrote ${logs.length} experiments to ${options.out}`))
    } else {
      process.stdout.write(output)
    }
  })

const queries = program.command('queries').description('Query set utilities.')
queries
  .command('generate')
  .description('Generate a fresh 50-query set from the current catalog and write to disk.')
  .option('-n, --count <n>', 'Number of queries', parseIntArg, 50)
  .option('-o, --out <path>', 'Output JSON path', 'shelf-queries.json')
  .option('--dry-run', 'Mock Anthropic calls — zero cost, uses fixture queries', false)
  .option('--no-shopify', 'With --dry-run, also skip Shopify Admin API calls (use fixture products)', false)
  .option('--store-category <label>', 'Category hint for query generation')
  .action(
    async (options: {
      count: number
      out: string
      dryRun: boolean
      shopify: boolean
      storeCategory?: string
    }) => {
      const noShopify = options.shopify === false
      if (noShopify && !options.dryRun) {
        console.error(chalk.red('✗ --no-shopify requires --dry-run (we only skip real Shopify in dry-run).'))
        process.exitCode = 1
        return
      }
      const config = safeLoadConfig({ dryRun: options.dryRun, noShopify })
      const anthropicKey = config.providers.anthropic?.apiKey
      if (!config.dryRun && !anthropicKey) {
        console.error(chalk.red('✗ ANTHROPIC_API_KEY required to generate queries.'))
        process.exitCode = 1
        return
      }

      let products: ShopifyProduct[]
      if (noShopify) {
        products = loadFixtureProducts()
        console.log(chalk.dim(`  → loaded ${products.length} fixture products (--no-shopify)`))
      } else {
        const admin = await ShopifyAdminClient.create({
          storeDomain: config.store.domain,
          accessToken: config.store.adminAccessToken,
          clientId: config.store.clientId,
          clientSecret: config.store.clientSecret,
        })
        const fetchSpin = ora('Fetching products').start()
        products = await admin.listProducts()
        fetchSpin.succeed(`Fetched ${products.length} products`)
      }

      const genSpin = ora(`Generating ${options.count} queries`).start()
      try {
        const generator = new QueryGenerator({ apiKey: anthropicKey, dryRun: config.dryRun })
        const result = await generator.generate({
          products,
          count: options.count,
          storeCategory: options.storeCategory,
        })
        writeFileSync(resolve(process.cwd(), options.out), JSON.stringify(result, null, 2), 'utf-8')
        genSpin.succeed(`Wrote ${result.length} queries to ${options.out}`)

        const byIntent: Record<string, number> = {}
        for (const q of result) byIntent[q.intent] = (byIntent[q.intent] ?? 0) + 1
        const table = new Table({ head: [chalk.bold('intent'), chalk.bold('count')] })
        for (const [intent, count] of Object.entries(byIntent)) {
          table.push([intent, String(count)])
        }
        console.log(table.toString())
      } catch (err) {
        genSpin.fail(`Failed: ${errorMessage(err)}`)
        process.exitCode = 1
      }
    },
  )

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(`✗ ${errorMessage(err)}`))
  process.exitCode = 1
})

function safeLoadConfig(overrides: Parameters<typeof loadConfig>[0]) {
  try {
    return loadConfig(overrides)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(chalk.red(`✗ ${err.message}`))
    } else {
      console.error(chalk.red(`✗ ${errorMessage(err)}`))
    }
    process.exit(1)
  }
}

function parseIntArg(raw: string): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) throw new Error(`expected integer, got ${raw}`)
  return n
}

function parseFloatArg(raw: string): number {
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) throw new Error(`expected number, got ${raw}`)
  return n
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function renderEvent(event: ShelfEvent): void {
  const elapsed = formatElapsed(event.elapsedMs)
  const cost = `$${event.costUsd.toFixed(3)}`
  const head = chalk.dim(`[iter ${String(event.iteration).padStart(3)} · ${elapsed} · ${cost}]`)
  switch (event.type) {
    case 'session:start':
      console.log(
        `${head} ${chalk.bold('▶ session start')}  baseline=${chalk.yellow(event.baselineScore.toFixed(1))} products=${event.productsCount} queries=${event.queriesCount} max=${event.maxIterations} budget=$${event.budgetLimitUsd}`,
      )
      break
    case 'hypothesis:proposed':
      console.log(
        `${head} ${chalk.blue('◆ hypothesis')}  ${chalk.bold(event.hypothesis.type)} on ${chalk.cyan(event.hypothesis.productTitle)} — ${truncate(event.hypothesis.description, 72)}`,
      )
      break
    case 'checks:failed':
      console.log(
        `${head} ${chalk.yellow('⚠ checks failed')}  ${event.failures.slice(0, 2).join('; ')}`,
      )
      break
    case 'hypothesis:applied':
      console.log(
        `${head} ${chalk.magenta('✎ applied')}  ${event.applyResult.changes.length} field change(s) to ${chalk.dim(event.productId)}`,
      )
      break
    case 'measurement:complete': {
      const delta = event.scoreAfter - event.scoreBefore
      const sign = delta >= 0 ? '+' : ''
      const color = delta > 0 ? chalk.green : delta < 0 ? chalk.red : chalk.dim
      console.log(
        `${head} ${chalk.cyan('↺ measured')}  ${event.scoreBefore.toFixed(1)} → ${event.scoreAfter.toFixed(1)} (${color(sign + delta.toFixed(2))}, ${event.confidence})`,
      )
      break
    }
    case 'experiment:kept':
      console.log(
        `${head} ${chalk.green.bold('✓ kept')}  ${chalk.green(`+${event.scoreDelta.toFixed(2)}`)} (${event.confidence})`,
      )
      break
    case 'experiment:kept_uncertain':
      console.log(
        `${head} ${chalk.greenBright('✓ kept*')}  ${chalk.greenBright(`+${event.scoreDelta.toFixed(2)}`)} (uncertain, ${event.confidence})`,
      )
      break
    case 'experiment:reverted':
      console.log(
        `${head} ${chalk.red('✗ reverted')}  Δ ${event.scoreDelta.toFixed(2)} (${event.confidence})`,
      )
      break
    case 'budget:warning':
      console.log(
        `${head} ${chalk.yellow.bold('$ budget warning')}  $${event.cumulativeCostUsd.toFixed(2)}/$${event.limitUsd} (remaining $${event.remainingUsd.toFixed(2)})`,
      )
      break
    case 'session:end': {
      const delta = event.finalScore - event.baselineScore
      const sign = delta >= 0 ? '+' : ''
      const color = delta > 0 ? chalk.green : chalk.red
      const spent = `$${event.totalCostUsd.toFixed(2)}`
      if (event.stopReason === 'budget exhausted') {
        console.log(
          `${head} ${chalk.red.bold('🛑 BUDGET CAP HIT — stopping')}  spent ${chalk.red.bold(spent)} (limit reached). Raise SHELF_BUDGET_LIMIT_USD to continue.`,
        )
      }
      console.log(
        `${head} ${chalk.bold('■ session end')}  ${event.baselineScore.toFixed(1)} → ${event.finalScore.toFixed(1)} (${color(sign + delta.toFixed(1))}) over ${event.totalIterations} iters · spent ${spent} · reason: ${event.stopReason}`,
      )
      break
    }
  }
}

function formatElapsed(ms: number): string {
  const multiplier = Number.parseFloat(process.env.SHELF_ELAPSED_MULTIPLIER ?? '1') || 1
  const totalSeconds = Math.floor((ms * multiplier) / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}m${s.toString().padStart(2, '0')}s`
}

// Dashboard runs as a separate process and can't read this process's env.
// Drop the multiplier in .shelf-cache/ so the SSE route can pick it up.
function writeElapsedSidecar(multiplier: number): void {
  try {
    const cacheDir = resolve(process.cwd(), '.shelf-cache')
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
    writeFileSync(
      resolve(cacheDir, 'elapsed-multiplier'),
      String(multiplier),
      'utf-8',
    )
  } catch {
    // non-fatal — demo-only feature
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function printQrBanner(): void {
  console.log(chalk.bold.cyan('\n  shelf — autoresearch for storefronts\n'))
  qrcode.generate('https://github.com/AnirudhDabas/shelf', { small: true }, (qr: string) => {
    console.log(qr)
  })
  console.log(chalk.dim('  github.com/AnirudhDabas/shelf\n'))
}

async function runLiveStability(
  config: ReturnType<typeof loadConfig>,
  options: { products: number; runs: number; storeCategory?: string },
): Promise<ReturnType<typeof emptyStabilityReport>> {
  const anthropicKey = config.providers.anthropic?.apiKey
  if (!anthropicKey) {
    return emptyStabilityReport(
      '--live requires ANTHROPIC_API_KEY for query generation.',
    )
  }
  const providers = buildProviders(config, { cache: new FileCache(), dryRun: false })
  if (providers.length === 0) {
    return emptyStabilityReport(
      '--live requires at least one scoring provider (PERPLEXITY_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY).',
    )
  }

  let products: ShopifyProduct[]
  if (config.noShopify) {
    products = loadFixtureProducts()
  } else {
    const adminSpin = ora('Authenticating with Shopify Admin API').start()
    try {
      const admin = await ShopifyAdminClient.create({
        storeDomain: config.store.domain,
        accessToken: config.store.adminAccessToken,
        clientId: config.store.clientId,
        clientSecret: config.store.clientSecret,
      })
      adminSpin.succeed('Authenticated')
      const fetchSpin = ora('Fetching products').start()
      products = await admin.listProducts()
      fetchSpin.succeed(`Fetched ${products.length} products`)
    } catch (err) {
      adminSpin.fail(`Auth failed: ${errorMessage(err)}`)
      throw err
    }
  }

  const querySpin = ora('Generating queries for stability sample').start()
  const queryGen = new QueryGenerator({ apiKey: anthropicKey, dryRun: false })
  const queries = await queryGen.generate({
    products,
    count: 50,
    storeCategory: options.storeCategory,
  })
  querySpin.succeed(`Generated ${queries.length} queries`)

  const stabSpin = ora(`Measuring stability across ${options.runs} repeat run(s)…`).start()
  const result = await computeScoreStability({
    products,
    queries,
    providers,
    storeDomain: config.store.domain,
    runs: options.runs,
    productCount: options.products,
    repetitions: config.loop.queriesPerMeasurement,
    onRun: (run, total) => {
      stabSpin.text = `Stability run ${run}/${total}…`
    },
  })
  stabSpin.succeed('Stability sweep complete')
  return result
}

function renderEvalToTerminal(report: ReturnType<typeof buildEvalReport>): void {
  console.log(chalk.bold.cyan(`\n🛒 shelf eval — ${report.storeDomain}`))
  console.log(
    chalk.dim(
      `${report.totalExperiments} experiment(s) · ${report.generatedAt.slice(0, 10)} · ${report.jsonlPath}\n`,
    ),
  )

  console.log(chalk.bold('Hypothesis Effectiveness'))
  const heff = report.hypothesisEffectiveness
  if (heff.rows.length === 0) {
    console.log(chalk.dim('  (no experiments)'))
  } else {
    const table = new Table({
      head: [
        chalk.bold('type'),
        chalk.bold('total'),
        chalk.bold('kept'),
        chalk.bold('keep %'),
        chalk.bold('Δ kept'),
        chalk.bold('Δ rev'),
        chalk.bold('iters→1st'),
        chalk.bold('EV'),
      ],
    })
    for (const r of heff.rows) {
      table.push([
        r.type,
        String(r.total),
        String(r.kept),
        `${(r.keepRate * 100).toFixed(0)}%`,
        r.avgScoreDeltaKept.toFixed(2),
        r.avgScoreDeltaReverted.toFixed(2),
        r.medianIterationsToFirstKeep === null
          ? '—'
          : String(r.medianIterationsToFirstKeep),
        r.expectedValuePerAttempt.toFixed(2),
      ])
    }
    console.log(table.toString())
    if (heff.priorityOrder.length > 0) {
      console.log(
        chalk.dim(`  priority for 10-iter budget: ${heff.priorityOrder.join(' → ')}`),
      )
    }
  }

  console.log('\n' + chalk.bold('Score Stability'))
  const stab = report.scoreStability
  if (!stab.performed) {
    console.log(chalk.dim(`  ${stab.reason ?? 'skipped'}`))
  } else if (stab.rows.length === 0) {
    console.log(chalk.dim(`  ${stab.reason ?? 'no data'}`))
  } else {
    const table = new Table({
      head: [
        chalk.bold('product'),
        chalk.bold('mean'),
        chalk.bold('std'),
        chalk.bold('CV'),
        chalk.bold('min'),
        chalk.bold('max'),
      ],
    })
    for (const r of stab.rows) {
      table.push([
        truncate(r.productTitle, 32),
        r.mean.toFixed(1),
        r.stdDev.toFixed(2),
        `${(r.coefficientOfVariation * 100).toFixed(1)}%`,
        r.min.toFixed(1),
        r.max.toFixed(1),
      ])
    }
    console.log(table.toString())
    const verdictColor =
      stab.verdict === 'stable'
        ? chalk.green
        : stab.verdict === 'moderate'
          ? chalk.yellow
          : chalk.red
    console.log(
      `  mean CV: ${(stab.meanCoefficientOfVariation * 100).toFixed(1)}% — ${verdictColor(stab.verdictMessage)}`,
    )
  }

  console.log('\n' + chalk.bold('Plateau Detection'))
  const plateau = report.plateau
  if (plateau.series.length === 0) {
    console.log(chalk.dim(`  ${plateau.verdict}`))
  } else {
    const verdictColor = plateau.plateauIteration !== null ? chalk.yellow : chalk.green
    console.log(`  ${verdictColor(plateau.verdict)}`)
    console.log(
      chalk.dim(
        `  ${plateau.baselineScore.toFixed(1)} → ${plateau.finalScore.toFixed(1)} over ${plateau.totalIterations} iter · cost $${plateau.cumulativeCostUsd.toFixed(4)}` +
          (plateau.costPerScorePoint !== null
            ? ` (~$${plateau.costPerScorePoint.toFixed(4)}/pt)`
            : ''),
      ),
    )
  }

  console.log('\n' + chalk.bold('Provider Disagreement'))
  const pd = report.providerDisagreement
  if (!pd.available) {
    console.log(chalk.dim(`  ${pd.reason ?? 'unavailable'}`))
  } else {
    const table = new Table({
      head: [chalk.bold('provider'), chalk.bold('keep %'), chalk.bold('final')],
    })
    for (const name of pd.providers) {
      const series = pd.perProviderScoreTrajectory[name] ?? []
      const last = series[series.length - 1]
      table.push([
        name,
        `${(pd.perProviderKeepRate[name] * 100).toFixed(0)}%`,
        last ? last.score.toFixed(1) : '—',
      ])
    }
    console.log(table.toString())
    console.log(chalk.dim(`  disagreement rate: ${(pd.disagreementRate * 100).toFixed(1)}% — ${pd.verdict}`))
  }

  console.log('\n' + chalk.bold('Reward Hacking Audit'))
  const rh = report.rewardHacking
  if (!rh.available) {
    console.log(chalk.dim(`  ${rh.reason ?? 'unavailable'}`))
  } else {
    const riskColor =
      rh.risk === 'high' ? chalk.red : rh.risk === 'medium' ? chalk.yellow : chalk.green
    console.log(`  Risk: ${riskColor.bold(rh.risk.toUpperCase())} — ${rh.verdict}`)
    console.log(
      chalk.dim(
        `  title slope ${rh.titleLengthSlope.toFixed(3)} ch/iter · grade slope ${rh.descriptionGradeSlope.toFixed(3)}/iter · keyword slope ${rh.keywordDensitySlope.toFixed(3)}/iter`,
      ),
    )
    console.log(
      chalk.dim(
        `  coverage: ${rh.productCoverage.uniqueProducts} unique product(s) across ${rh.productCoverage.keptExperiments} kept (top ${(rh.productCoverage.topProductShare * 100).toFixed(0)}%)`,
      ),
    )
    for (const sig of rh.signals) console.log(chalk.yellow(`  ⚠ ${sig}`))
  }

  console.log('\n' + chalk.bold('Summary'))
  console.log(`  ${report.summary}`)
}

export { program }
