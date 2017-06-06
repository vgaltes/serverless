'use strict';

const childProcess = require('child_process');
const archiver = require('archiver');
const BbPromise = require('bluebird');
const path = require('path');
const fs = require('fs');
const globby = require('globby');
const _ = require('lodash');
const fileExistsSync = require('../../../utils/fs/fileExistsSync');

module.exports = {
  zipDirectory(exclude, include, zipFileName) {
    this.exclude = exclude;
    this.include = include;
    this.zipFileName = zipFileName;

    return BbPromise.bind(this)
      .then(this.excludeDevDependencies)
      .then(this.zip);
  },

  excludeDevDependencies() {
    // take care of node runtime-services
    try {
      const packageJsonFilePath = path.join(this.serverless.config.servicePath, 'package.json');

      if (fileExistsSync(packageJsonFilePath)) {
        // TODO replace with package-manager independent directory traversal?!
        const prodDependencies = childProcess
          .execSync('npm ls --prod=true --parseable=true --silent')
          .toString().trim();

        const normalizedDependencyPaths = prodDependencies.match(/(node_modules\/.*)/g);
        const includePatterns = normalizedDependencyPaths.map(normPath => `${normPath}/**`);

        // at first exclude the whole node_modules directory
        // after that re-include the production relevant modules
        this.exclude = _.union(this.exclude, ['node_modules/**']);
        this.include = _.union(this.include, includePatterns);
      }
    } catch (e) {
      // npm is not installed
    }

    return BbPromise.resolve();
  },

  zip() {
    const patterns = ['**'];

    this.exclude.forEach((pattern) => {
      if (pattern.charAt(0) !== '!') {
        patterns.push(`!${pattern}`);
      } else {
        patterns.push(pattern.substring(1));
      }
    });

    // push the include globs to the end of the array
    // (files and folders will be re-added again even if they were excluded beforehand)
    this.include.forEach((pattern) => {
      patterns.push(pattern);
    });

    const zip = archiver.create('zip');
    // Create artifact in temp path and move it to the package path (if any) later
    const artifactFilePath = path.join(this.serverless.config.servicePath,
      '.serverless',
      this.zipFileName
    );
    this.serverless.utils.writeFileDir(artifactFilePath);

    const output = fs.createWriteStream(artifactFilePath);

    const files = globby.sync(patterns, {
      cwd: this.serverless.config.servicePath,
      dot: true,
      silent: true,
      follow: true,
    });

    if (files.length === 0) {
      const error = new this.serverless
        .classes.Error('No file matches include / exclude patterns');
      return BbPromise.reject(error);
    }

    output.on('open', () => {
      zip.pipe(output);

      files.forEach((filePath) => {
        const fullPath = path.resolve(
          this.serverless.config.servicePath,
          filePath
        );

        const stats = fs.statSync(fullPath);

        if (!stats.isDirectory(fullPath)) {
          zip.append(fs.readFileSync(fullPath), {
            name: filePath,
            mode: stats.mode,
          });
        }
      });

      zip.finalize();
    });

    return new BbPromise((resolve, reject) => {
      output.on('close', () => resolve(artifactFilePath));
      zip.on('error', (err) => reject(err));
    });
  },
};
