#!/usr/bin/env node

import { program } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { URL } from 'url';
import { createInterface } from 'readline';
import { SingleBar, Presets } from 'cli-progress';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import axios from 'axios';
import PQueue from 'p-queue';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


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


// Directories and patterns to ignore
const IGNORE_PATTERNS = [
    'node_modules/',
];

// Set up command line arguments
program
    .version('1.0.0')
    .option('-u, --url <url>', 'URL to download from')
    .option('--include-node-modules', 'Include node_modules in download')
    .parse(process.argv);

const options = program.opts();

// Create base downloads directory
const BASE_DOWNLOAD_DIR = './downloads';
if (!existsSync(BASE_DOWNLOAD_DIR)) {
  mkdirSync(BASE_DOWNLOAD_DIR);
}

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

function ensureDirectoryExists(filePath) {
  const directory = dirname(filePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}


// Modified download function using axios
async function downloadFile(url, relativePath, basePath, auth = null) {
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
  } catch (error) {
    console.error(chalk.red(`Error downloading ${relativePath}: ${error.message}`));
    throw error;
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

function isIndexPage(html) {
  // Check for common "Index of" patterns
  const patterns = [
    /Index of/i,
    /<title>\s*Index of/i,
    /\[To Parent Directory\]/i,
    /Directory listing/i,
    /Parent Directory/i
  ];

  return patterns.some(pattern => pattern.test(html));
}


// Modified HTML fetching using axios
async function getDirectoryContents(baseUrl, currentPath = '', auth = null) {
  const url = new URL(currentPath, baseUrl).toString();
  const config = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    responseType: 'text'
  };

  if (auth) {
    config.auth = {
      username: auth.username,
      password: auth.password
    };
  }

  try {
    const response = await axios.get(url, config);
    const html = response.data;

    if (!isIndexPage(html)) {
      console.log(chalk.yellow(`Skipping non-index page: ${url}`));
      return { files: [], directories: [] };
    }

    const linkRegex = /href="([^"]+)"/g;
    const files = [];
    const directories = [];
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const link = match[1];

      if (link === '../' || link.startsWith('/') || link.startsWith('?') || link === './') {
        continue;
      }

      if (shouldIgnorePath(link)) {
        console.log(chalk.yellow(`Skipping ignored path: ${link}`));
        continue;
      }

      if (link.endsWith('/')) {
        directories.push(link);
      } else {
        files.push(link);
      }
    }

    return { files, directories };
  } catch (error) {
    console.error(chalk.red(`Error fetching directory contents: ${error.message}`));
    return { files: [], directories: [] };
  }
}


// Modified directory processing with concurrent downloads
async function processDirectory(baseUrl, currentPath = '', auth = null, depth = 0) {
  if (shouldIgnorePath(currentPath)) {
    console.log(chalk.yellow(`Skipping ignored directory: ${currentPath}`));
    return;
  }

  console.log(chalk.blue(`\nScanning directory: ${currentPath || '/'}`));

  const { files, directories } = await getDirectoryContents(baseUrl, currentPath, auth);
  const basePath = getBasePath(baseUrl);

  // Add all files to the download queue
  const downloadPromises = files.map(file => {
    const relativePath = join(currentPath, file);
    const fileUrl = new URL(relativePath, baseUrl).toString();

    return queue.add(() =>
        downloadFile(fileUrl, relativePath, basePath, auth)
            .catch(error => {
              console.error(chalk.red(`Failed to download ${relativePath}: ${error.message}`));
            })
    );
  });

  // Process all downloads concurrently
  await Promise.all(downloadPromises);

  // Process subdirectories
  for (const dir of directories) {
    const newPath = join(currentPath, dir);
    await processDirectory(baseUrl, newPath, auth, depth + 1);
  }
}
async function validateIndexPage(url, auth = null) {
  const options = {
    headers: {
      'User-Agent': 'Node-Downloader'
    }
  };

  if (auth) {
    const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    options.headers['Authorization'] = `Basic ${credentials}`;
  }

  try {
    const response = await fetch(url, options);
    const html = await response.text();
    return isIndexPage(html);
  } catch (error) {
    console.error(chalk.red('Error accessing URL:', error.message));
    return false;
  }
}


async function main() {
  program
      .version('1.0.0')
      .option('-u, --url <url>', 'URL to download from')
      .option('--include-node-modules', 'Include node_modules in download')
      .option('-c, --concurrency <number>', 'Number of concurrent downloads', '5')
      .parse(process.argv);

  const options = program.opts();

  // Update queue concurrency if specified
  if (options.concurrency) {
    queue.concurrency = parseInt(options.concurrency, 10);
  }

  try {
    console.log(chalk.blue('\n=== "Index of" Downloader ===\n'));
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

    console.log(chalk.green('\nStarting download process...'));
    await processDirectory(url, '', auth);

    console.log(chalk.green('\nAll downloads complete!'));

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    await new Promise(resolve => rl.question('Press Enter to exit...', resolve));
    rl.close();

  } catch (error) {
    console.error(chalk.red('\nError:', error.message));
    process.exit(1);
  }
}

main();