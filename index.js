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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

async function downloadFile(url, relativePath, basePath, auth = null) {
  const outputPath = join(basePath, relativePath);
  ensureDirectoryExists(outputPath);

  return new Promise(async (resolve, reject) => {
    try {
      const options = {
        headers: {
          'User-Agent': 'Node-Downloader'
        }
      };

      if (auth) {
        const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        options.headers['Authorization'] = `Basic ${credentials}`;
      }

      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const totalSize = parseInt(response.headers.get('content-length')) || 0;
      const progressBar = new SingleBar({}, Presets.shades_classic);
      let downloadedSize = 0;

      progressBar.start(totalSize, 0);

      const fileStream = createWriteStream(outputPath);
      const stream = response.body;

      for await (const chunk of stream) {
        downloadedSize += chunk.length;
        progressBar.update(downloadedSize);
        fileStream.write(chunk);
      }

      fileStream.end();
      progressBar.stop();
      resolve();
    } catch (error) {
      reject(error);
    }
  });
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

async function getDirectoryContents(baseUrl, currentPath = '', auth = null) {
  const url = new URL(currentPath, baseUrl).toString();
  const options = {
    headers: {
      'User-Agent': 'Node-Downloader'
    }
  };

  if (auth) {
    const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    options.headers['Authorization'] = `Basic ${credentials}`;
  }

  const response = await fetch(url, options);
  const html = await response.text();
  
  // Parse HTML for links
  const linkRegex = /href="([^"]+)"/g;
  const files = [];
  const directories = [];
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const link = match[1];
    
    // Skip parent directory and invalid links
    if (link === '../' || link.startsWith('/') || link.startsWith('?') || link === './') {
      continue;
    }

    // Check if path should be ignored
    if (shouldIgnorePath(link)) {
      console.log(chalk.yellow(`Skipping ignored path: ${link}`));
      continue;
    }

    // Determine if it's a directory (ends with /)
    if (link.endsWith('/')) {
      directories.push(link);
    } else {
      files.push(link);
    }
  }

  return { files, directories };
}

async function processDirectory(baseUrl, currentPath = '', auth = null, depth = 0) {
  if (shouldIgnorePath(currentPath)) {
    console.log(chalk.yellow(`Skipping ignored directory: ${currentPath}`));
    return;
  }

  console.log(chalk.blue(`\nScanning directory: ${currentPath || '/'}`));
  
  const { files, directories } = await getDirectoryContents(baseUrl, currentPath, auth);
  const basePath = getBasePath(baseUrl);
  
  // Download files in current directory
  for (const file of files) {
    const relativePath = join(currentPath, file);
    const fileUrl = new URL(relativePath, baseUrl).toString();
    
    console.log(chalk.gray(`Downloading: ${relativePath}`));
    await downloadFile(fileUrl, relativePath, basePath, auth);
  }

  // Recursively process subdirectories
  for (const dir of directories) {
    const newPath = join(currentPath, dir);
    await processDirectory(baseUrl, newPath, auth, depth + 1);
  }
}

async function main() {
  try {
    console.log(chalk.blue('\n=== "Index of" Downloader ===\n'));

    const url = await promptForUrl();
    if (!url) process.exit(0);

    const domain = getDomainFromUrl(url);
    const basePath = getBasePath(url);
    console.log(chalk.gray(`\nDownloads will be saved to: ${resolve(basePath)}`));
    
    if (!options.includeNodeModules) {
        console.log(chalk.yellow('\nNote: node_modules and other common development directories will be skipped.'));
        console.log(chalk.yellow('Use --include-node-modules flag to include node_modules.'));
    }

    let auth = null;
    try {
      const response = await fetch(url);
      if (response.status === 401) {
        console.log(chalk.yellow('\n401 - Authentication required'));
        auth = await promptForCredentials();
      }
    } catch (err) {
      console.error(chalk.red('Error accessing URL:', err.message));
      process.exit(1);
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