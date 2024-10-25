#!/usr/bin/env node

import { program } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve, extname } from 'path';
import { URL } from 'url';
import { createInterface } from 'readline';
import { SingleBar, Presets } from 'cli-progress';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import axios from 'axios';
import PQueue from 'p-queue';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Add file statistics tracking
const fileStats = {
  totalFiles: 0,
  totalSize: 0,
  extensionCounts: {},
  extensionSizes: {},
  envFiles: [], // Track found .env files
  sensitiveFiles: [] // Track other sensitive files
};

// Configure axios
const axiosInstance = axios.create({
  responseType: 'stream',
  maxRedirects: 5,
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

// Create download queue with concurrency
const queue = new PQueue({ concurrency: 5 });

// Common sensitive file patterns
const SENSITIVE_FILE_PATTERNS = [
  /\.env$/i,
  /\.env\./i,
  /config\.json$/i,
  /credentials\./i,
  /secret/i,
  /password/i,
  /apikey/i,
  /\.pem$/i,
  /\.key$/i,
  /\.cert$/i
];

// Directories and patterns to ignore
const IGNORE_PATTERNS = [
  'node_modules/',
  '.git/',
  '.svn/',
  '.idea/',
  '.vscode/',
  '__pycache__/',
  'dist/',
  'build/',
  'tmp/',
  'temp/'
];
// Add retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000, // 1 second between retries
  timeoutErrors: ['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']
};


// Set up command line arguments
program
    .version('1.0.0')
    .option('-u, --url <url>', 'URL to download from')
    .option('--include-node-modules', 'Include node_modules in download')
    .option('-c, --concurrency <number>', 'Number of concurrent downloads', '5')
    .option('--env-only', 'Only search for .env and sensitive files')
    .parse(process.argv);

const options = program.opts();

// Create base downloads directory
const BASE_DOWNLOAD_DIR = './downloads';
if (!existsSync(BASE_DOWNLOAD_DIR)) {
  mkdirSync(BASE_DOWNLOAD_DIR);
}

// Helper function for delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function getDomainFromUrl(urlString) {
  const url = new URL(urlString);
  return url.hostname;
}

function getBasePath(urlString) {
  const url = new URL(urlString);
  const domain = url.hostname;
  const pathParts = url.pathname.split('/').filter(Boolean);
  return join(BASE_DOWNLOAD_DIR, domain, ...pathParts);
}

async function promptForUrl() {
  if (options.url) return options.url;

  const { url } = await inquirer.prompt([{
    type: 'input',
    name: 'url',
    message: 'Please enter URL:',
    default: 'https://',
    validate: (input) => {
      try {
        new URL(input);
        return true;
      } catch (err) {
        return 'Please enter a valid URL';
      }
    }
  }]);

  return url;
}

function shouldIgnorePath(path) {
  if (options.includeNodeModules) {
    const reducedIgnorePatterns = IGNORE_PATTERNS.filter(pattern => pattern !== 'node_modules/');
    return reducedIgnorePatterns.some(pattern => path.includes(pattern));
  }
  return IGNORE_PATTERNS.some(pattern => path.includes(pattern));
}

function isSensitiveFile(filename) {
  return SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(filename));
}

function ensureDirectoryExists(filePath) {
  const directory = dirname(filePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}
// Add this function to filter Apache sorting URLs
function isApacheSortingUrl(href) {
  return /\?C=[NMDS];O=[AD]/.test(href);
}

async function parsePageForLinks(html, url) {
  const $ = cheerio.load(html);
  const links = new Set();

  // Find all links
  $('a').each((_, element) => {
    const href = $(element).attr('href');
    if (href) {
      // Skip Apache sorting URLs
      if (isApacheSortingUrl(href)) {
        return;
      }

      try {
        const absoluteUrl = new URL(href, url).toString();
        if (absoluteUrl.startsWith(url)) {
          // Remove query parameters from the href
          const cleanHref = href.split('?')[0];
          if (cleanHref) {
            links.add(cleanHref);
          }
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }
  });

  return Array.from(links);
}


// Enhanced download function with retry logic
async function downloadFile(url, relativePath, basePath, auth = null, retryCount = 0) {
  const outputPath = join(basePath, relativePath);
  ensureDirectoryExists(outputPath);

  const config = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };

  if (auth) {
    config.auth = {
      username: auth.username,
      password: auth.password
    };
  }

  try {
    const response = await axiosInstance.get(url, config);
    const totalLength = parseInt(response.headers['content-length'], 10);

    const progressBar = new SingleBar({
      format: `${relativePath} |{bar}| {percentage}% | {value}/{total} bytes`,
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591'
    }, Presets.shades_classic);

    if (isNaN(totalLength)) {
      console.log(chalk.yellow(`Unknown size for ${relativePath}`));
    } else {
      progressBar.start(totalLength, 0);
    }

    const writer = createWriteStream(outputPath);
    let downloadedLength = 0;

    response.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      if (!isNaN(totalLength)) {
        progressBar.update(downloadedLength);
      }
    });

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.pipe(writer);
    });

    if (!isNaN(totalLength)) {
      progressBar.stop();
    }

    // Update file statistics
    const extension = extname(relativePath).toLowerCase() || 'no-extension';
    fileStats.totalFiles++;
    fileStats.totalSize += downloadedLength;

    fileStats.extensionCounts[extension] = (fileStats.extensionCounts[extension] || 0) + 1;
    fileStats.extensionSizes[extension] = (fileStats.extensionSizes[extension] || 0) + downloadedLength;

    if (relativePath.toLowerCase().includes('.env')) {
      fileStats.envFiles.push({ path: relativePath, size: downloadedLength });
    } else if (isSensitiveFile(relativePath)) {
      fileStats.sensitiveFiles.push({ path: relativePath, size: downloadedLength });
    }

  } catch (error) {
    // Check if the error is a timeout or connection error
    const isTimeoutError = RETRY_CONFIG.timeoutErrors.includes(error.code);

    if (error.response?.status === 404) {
      console.log(chalk.yellow(`File not found (404): ${relativePath} - skipping`));
      return;
    }

    if (isTimeoutError && retryCount < RETRY_CONFIG.maxRetries) {
      console.log(chalk.yellow(`\nTimeout downloading ${relativePath} - Retry ${retryCount + 1}/${RETRY_CONFIG.maxRetries}`));
      await delay(RETRY_CONFIG.retryDelay);
      return downloadFile(url, relativePath, basePath, auth, retryCount + 1);
    }

    if (retryCount === RETRY_CONFIG.maxRetries) {
      console.error(chalk.red(`\nFailed to download ${relativePath} after ${RETRY_CONFIG.maxRetries} retries - skipping`));
    } else {
      console.error(chalk.red(`\nError downloading ${relativePath}: ${error.message} - skipping`));
    }
  }
}

async function promptForCredentials() {
  const { username, password } = await inquirer.prompt([
    {
      type: 'input',
      name: 'username',
      message: 'Enter username:'
    },
    {
      type: 'password',
      name: 'password',
      message: 'Enter password:'
    }
  ]);

  return { username, password };
}



// Enhanced getPageContents with retry logic
async function getPageContents(url, auth = null, retryCount = 0) {
  const config = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };

  if (auth) {
    config.auth = {
      username: auth.username,
      password: auth.password
    };
  }

  try {
    const cleanUrl = url.split('?')[0];
    const response = await axios.get(cleanUrl, config);
    const html = response.data;
    const links = await parsePageForLinks(html, cleanUrl);

    const files = [];
    const directories = [];

    for (const link of links) {
      if (shouldIgnorePath(link)) continue;
      if (!link || isApacheSortingUrl(link)) continue;

      if (link.endsWith('/')) {
        directories.push(link);
      } else {
        files.push(link);
      }
    }

    // Special check for .env files
    try {
      const envCheck = await axios.get(new URL('.env', cleanUrl).toString(), config);
      if (envCheck.status === 200) {
        files.push('.env');
      }
    } catch (error) {
      // Silently ignore errors when checking for .env files
    }

    return { files, directories, isIndex: isIndexPage(html) };
  } catch (error) {
    const isTimeoutError = RETRY_CONFIG.timeoutErrors.includes(error.code);

    if (error.response?.status === 404) {
      console.log(chalk.yellow(`Directory not found (404): ${url} - skipping`));
      return { files: [], directories: [], isIndex: false };
    }

    if (isTimeoutError && retryCount < RETRY_CONFIG.maxRetries) {
      console.log(chalk.yellow(`\nTimeout accessing ${url} - Retry ${retryCount + 1}/${RETRY_CONFIG.maxRetries}`));
      await delay(RETRY_CONFIG.retryDelay);
      return getPageContents(url, auth, retryCount + 1);
    }

    if (retryCount === RETRY_CONFIG.maxRetries) {
      console.error(chalk.red(`Failed to access ${url} after ${RETRY_CONFIG.maxRetries} retries - skipping`));
    } else {
      console.error(chalk.yellow(`Warning: Could not access ${url}: ${error.message} - skipping`));
    }

    return { files: [], directories: [], isIndex: false };
  }
}


function isIndexPage(html) {
  const patterns = [
    /Index of/i,
    /<title>\s*Index of/i,
    /\[To Parent Directory\]/i,
    /Directory listing/i,
    /Parent Directory/i
  ];
  return patterns.some(pattern => pattern.test(html));
}


// Enhanced processDirectory with better error handling
async function processDirectory(baseUrl, currentPath = '', auth = null, depth = 0) {
  if (shouldIgnorePath(currentPath)) {
    console.log(chalk.yellow(`Skipping ignored directory: ${currentPath}`));
    return;
  }

  console.log(chalk.blue(`\nScanning directory: ${currentPath || '/'}`));

  const url = new URL(currentPath, baseUrl).toString();
  const { files, directories, isIndex } = await getPageContents(url, auth);
  const basePath = getBasePath(baseUrl);

  // Process files
  const downloadPromises = files
      .filter(file => !options.envOnly || isSensitiveFile(file))
      .map(file => {
        const relativePath = join(currentPath, file);
        const fileUrl = new URL(relativePath, baseUrl).toString();

        return queue.add(() =>
            downloadFile(fileUrl, relativePath, basePath, auth)
        );
      });

  // Handle downloads with Promise.allSettled to continue even if some fail
  const results = await Promise.allSettled(downloadPromises);
  const failedDownloads = results.filter(r => r.status === 'rejected').length;
  if (failedDownloads > 0) {
    console.log(chalk.yellow(`\n${failedDownloads} files failed to download in directory: ${currentPath}`));
  }

  // Process subdirectories
  for (const dir of directories) {
    const newPath = join(currentPath, dir);
    await processDirectory(baseUrl, newPath, auth, depth + 1);
  }
}


function displayFileStatistics() {
  console.log(chalk.blue('\n=== Download Statistics ==='));
  console.log(chalk.white(`\nTotal files downloaded: ${fileStats.totalFiles}`));
  console.log(chalk.white(`Total size: ${(fileStats.totalSize / 1024 / 1024).toFixed(2)} MB\n`));

  if (fileStats.envFiles.length > 0) {
    console.log(chalk.red('\nFound .env files:'));
    fileStats.envFiles.forEach(file => {
      console.log(chalk.red(`- ${file.path} (${(file.size / 1024).toFixed(2)} KB)`));
    });
  }

  if (fileStats.sensitiveFiles.length > 0) {
    console.log(chalk.yellow('\nPotentially sensitive files:'));
    fileStats.sensitiveFiles.forEach(file => {
      console.log(chalk.yellow(`- ${file.path} (${(file.size / 1024).toFixed(2)} KB)`));
    });
  }

  console.log(chalk.blue('\nFiles by type:'));
  Object.entries(fileStats.extensionCounts)
      .sort(([, a], [, b]) => b - a)
      .forEach(([ext, count]) => {
        const size = (fileStats.extensionSizes[ext] / 1024 / 1024).toFixed(2);
        console.log(chalk.white(`${ext}: ${count} files (${size} MB)`));
      });
}

async function main() {
  try {
    console.log(chalk.blue('\n=== Directory Scanner & Downloader ===\n'));
    if (options.envOnly) {
      console.log(chalk.yellow('Running in env-only mode - only scanning for sensitive files'));
    }
    console.log(chalk.gray(`Concurrent downloads: ${queue.concurrency}`));

    const url = await promptForUrl();
    if (!url) process.exit(0);

    const domain = getDomainFromUrl(url);
    const basePath = getBasePath(url);

    let auth = null;
    try {
      const response = await axios.get(url);
      if (response.status === 401) {
        console.log(chalk.yellow('\n401 - Authentication required'));
        auth = await promptForCredentials();
      }
    } catch (err) {
      if (err.response && err.response.status === 401) {
        console.log(chalk.yellow('\n401 - Authentication required'));
        auth = await promptForCredentials();
      } else {
        console.error(chalk.red('Error accessing URL:', err.message));
        process.exit(1);
      }
    }

    console.log(chalk.gray(`\nDownloads will be saved to: ${resolve(basePath)}`));

    if (!options.includeNodeModules) {
      console.log(chalk.yellow('\nNote: node_modules and other common development directories will be skipped.'));
      console.log(chalk.yellow('Use --include-node-modules flag to include node_modules.'));
    }

    console.log(chalk.green('\nStarting scan process...'));
    await processDirectory(url, '', auth);

    console.log(chalk.green('\nScan complete!'));
    displayFileStatistics();

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    await new Promise(resolve => rl.question('\nPress Enter to exit...', resolve));
    rl.close();

  } catch (error) {
    console.error(chalk.red('\nError:', error.message));
    process.exit(1);
  }
}

main();