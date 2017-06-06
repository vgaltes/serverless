'use strict';

/* eslint-disable no-unused-expressions */

const chai = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JsZip = require('jszip');
const _ = require('lodash');
const childProcess = require('child_process');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const Package = require('../package');
const Serverless = require('../../../Serverless');
const testUtils = require('../../../../tests/utils');

// Configure chai
chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));
const expect = require('chai').expect;

describe('zipDirectory', () => {
  let tmpDirPath;
  let serverless;
  let packagePlugin;

  beforeEach(() => {
    tmpDirPath = testUtils.getTmpDirPath();
    serverless = new Serverless();
    serverless.service.service = 'first-service';
    serverless.config.servicePath = tmpDirPath;
    packagePlugin = new Package(serverless, {});
    packagePlugin.serverless.cli = new serverless.classes.CLI();
  });

  describe('#zipDirectory()', () => {
    let excludeDevDependenciesStub;
    let zipStub;

    beforeEach(() => {
      excludeDevDependenciesStub = sinon.stub(packagePlugin, 'excludeDevDependencies').resolves();
      zipStub = sinon.stub(packagePlugin, 'zip').resolves();
    });

    afterEach(() => {
      packagePlugin.excludeDevDependencies.restore();
      packagePlugin.zip.restore();
    });

    it('should run promise chain in order', () => {
      const exclude = 'exclude-me';
      const include = 'inlcude-me';
      const zipFileName = 'foo.zip';

      return expect(packagePlugin.zipDirectory(exclude, include, zipFileName)).to.be
        .fulfilled.then(() => {
          expect(excludeDevDependenciesStub).to.have.been.calledOnce;
          expect(zipStub).to.have.been.calledOnce;

          expect(packagePlugin.exclude).to.equal(exclude);
          expect(packagePlugin.include).to.equal(include);
          expect(packagePlugin.zipFileName).to.equal(zipFileName);
        });
    });
  });

  describe('#excludeDevDependencies()', () => {
    let fileExistsSyncStub;
    let execSyncStub;
    let packageJsonFilePath;

    beforeEach(() => {
      fileExistsSyncStub = sinon.stub();
      execSyncStub = sinon.stub(childProcess, 'execSync');
      const zipDirectory = proxyquire('./zipDirectory.js', {
        '../../../utils/fs/fileExistsSync': fileExistsSyncStub,
      });
      Object.assign(
        packagePlugin,
        zipDirectory
      );
      packageJsonFilePath = path.join(serverless.config.servicePath, 'package.json');
    });

    afterEach(() => {
      childProcess.execSync.restore();
    });

    it('should exclude dev dependencies for services with Node.js runtime', () => {
      fileExistsSyncStub.withArgs(packageJsonFilePath)
        .returns(true);
      execSyncStub.withArgs('npm ls --prod=true --parseable=true --silent')
        .returns('node_modules/foo\nnode_modules/bar');

      return expect(packagePlugin.excludeDevDependencies()).to.be.fulfilled.then(() => {
        expect(fileExistsSyncStub).to.have.been.calledOnce;
        expect(execSyncStub).to.have.been.calledOnce;
        expect(fileExistsSyncStub).to.have.been
          .calledWithExactly(packageJsonFilePath);
        expect(execSyncStub).to.have.been
          .calledWithExactly('npm ls --prod=true --parseable=true --silent');
        expect(packagePlugin.exclude).to
          .deep.equal(['node_modules/**']);
        expect(packagePlugin.include).to
          .deep.equal(['node_modules/foo/**', 'node_modules/bar/**']);
      });
    });

    it('should resolve if service is not using a Node.js runtime', () => {
      fileExistsSyncStub.withArgs(packageJsonFilePath)
        .returns(false);

      return expect(packagePlugin.excludeDevDependencies()).to.be.fulfilled.then(() => {
        expect(fileExistsSyncStub).to.have.been.calledOnce;
        expect(execSyncStub).to.not.have.been.called;
        expect(fileExistsSyncStub).to.have.been
          .calledWithExactly(packageJsonFilePath);
      });
    });
  });

  describe('#zip()', () => {
    let zip;

    const testDirectory = {
      // root
      '.': {
        'event.json': 'some content',
        'handler.js': 'some content',
        'file-1': 'some content',
        'file-2': 'some content',
      },
      // bin
      bin: {
        'binary-777': {
          content: 'some content',
          permissions: 777,
        },
        'binary-444': {
          content: 'some content',
          permissions: 444,
        },
      },
      // lib
      lib: {
        'file-1.js': 'some content',
      },
      'lib/directory-1': {
        'file-1.js': 'some content',
      },
      // node_modules
      'node_modules/directory-1': {
        'file-1': 'some content',
        'file-2': 'some content',
      },
      'node_modules/directory-2': {
        'file-1': 'some content',
        'file-2': 'some content',
      },
    };

    function getTestArtifactFileName(testName) {
      return `test-${testName}-${(new Date()).getTime().toString()}.zip`;
    }

    beforeEach(() => {
      zip = new JsZip();

      Object.keys(testDirectory).forEach(dirName => {
        const dirPath = path.join(tmpDirPath, dirName);
        const files = testDirectory[dirName];

        Object.keys(files).forEach(fileName => {
          const filePath = path.join(dirPath, fileName);
          const fileValue = files[fileName];
          const file = _.isObject(fileValue) ? fileValue : { content: fileValue };

          if (!file.content) {
            throw new Error('File content is required');
          }

          serverless.utils.writeFileSync(filePath, file.content);

          if (file.permissions) {
            fs.chmodSync(filePath, file.permissions);
          }
        });
      });
    });

    it('should zip a whole service (without include / exclude usage)', () => {
      const zipFileName = getTestArtifactFileName('whole-service');

      packagePlugin.exclude = [];
      packagePlugin.include = [];
      packagePlugin.zipFileName = zipFileName;

      return expect(packagePlugin.zip()).to.eventually.be
        .equal(path.join(serverless.config.servicePath, '.serverless', zipFileName))
      .then(artifact => {
        const data = fs.readFileSync(artifact);
        return expect(zip.loadAsync(data)).to.be.fulfilled;
      })
      .then(unzippedData => {
        const unzippedFileData = unzippedData.files;

        expect(Object.keys(unzippedFileData)
         .filter(file => !unzippedFileData[file].dir))
         .to.be.lengthOf(13);

        // root directory
        expect(unzippedFileData['event.json'].name)
          .to.equal('event.json');
        expect(unzippedFileData['handler.js'].name)
          .to.equal('handler.js');
        expect(unzippedFileData['file-1'].name)
          .to.equal('file-1');
        expect(unzippedFileData['file-2'].name)
          .to.equal('file-2');

        // bin directory
        expect(unzippedFileData['bin/binary-777'].name)
          .to.equal('bin/binary-777');
        expect(unzippedFileData['bin/binary-444'].name)
          .to.equal('bin/binary-444');

        // lib directory
        expect(unzippedFileData['lib/file-1.js'].name)
          .to.equal('lib/file-1.js');
        expect(unzippedFileData['lib/directory-1/file-1.js'].name)
          .to.equal('lib/directory-1/file-1.js');

        // node_modules directory
        expect(unzippedFileData['node_modules/directory-1/file-1'].name)
          .to.equal('node_modules/directory-1/file-1');
        expect(unzippedFileData['node_modules/directory-1/file-2'].name)
          .to.equal('node_modules/directory-1/file-2');
        expect(unzippedFileData['node_modules/directory-2/file-1'].name)
          .to.equal('node_modules/directory-2/file-1');
        expect(unzippedFileData['node_modules/directory-2/file-2'].name)
          .to.equal('node_modules/directory-2/file-2');
      });
    });

    it('should keep file permissions', () => {
      const zipFileName = getTestArtifactFileName('file-permissions');

      packagePlugin.exclude = [];
      packagePlugin.include = [];
      packagePlugin.zipFileName = zipFileName;

      return expect(packagePlugin.zip()).to.eventually.be
        .equal(path.join(serverless.config.servicePath, '.serverless', zipFileName))
      .then(artifact => {
        const data = fs.readFileSync(artifact);
        return expect(zip.loadAsync(data)).to.be.fulfilled;
      }).then(unzippedData => {
        const unzippedFileData = unzippedData.files;

        if (os.platform() === 'win32') {
          // chmod does not work right on windows. this is better than nothing?
          expect(unzippedFileData['bin/binary-777'].unixPermissions)
            .to.not.equal(unzippedFileData['bin/binary-444'].unixPermissions);
        } else {
          // binary file is set with chmod of 777
          expect(unzippedFileData['bin/binary-777'].unixPermissions)
            .to.equal(Math.pow(2, 15) + 777);

          // read only file is set with chmod of 444
          expect(unzippedFileData['bin/binary-444'].unixPermissions)
            .to.equal(Math.pow(2, 15) + 444);
        }
      });
    });

    it('should exclude with globs', () => {
      const zipFileName = getTestArtifactFileName('exclude-with-globs');

      packagePlugin.exclude = [
        'event.json',
        'lib/**',
        'node_modules/directory-1/**',
      ];
      packagePlugin.include = [];
      packagePlugin.zipFileName = zipFileName;

      return expect(packagePlugin.zip()).to.eventually.be
        .equal(path.join(serverless.config.servicePath, '.serverless', zipFileName))
      .then(artifact => {
        const data = fs.readFileSync(artifact);
        return expect(zip.loadAsync(data)).to.be.fulfilled;
      }).then(unzippedData => {
        const unzippedFileData = unzippedData.files;

        expect(Object.keys(unzippedFileData)
          .filter(file => !unzippedFileData[file].dir))
          .to.be.lengthOf(8);

        // root directory
        expect(unzippedFileData['handler.js'].name)
          .to.equal('handler.js');
        expect(unzippedFileData['file-1'].name)
          .to.equal('file-1');
        expect(unzippedFileData['file-2'].name)
          .to.equal('file-2');

        // bin directory
        expect(unzippedFileData['bin/binary-777'].name)
          .to.equal('bin/binary-777');
        expect(unzippedFileData['bin/binary-444'].name)
          .to.equal('bin/binary-444');

        // node_modules directory
        expect(unzippedFileData['node_modules/directory-2/file-1'].name)
          .to.equal('node_modules/directory-2/file-1');
        expect(unzippedFileData['node_modules/directory-2/file-2'].name)
          .to.equal('node_modules/directory-2/file-2');
      });
    });

    it('should re-include files using ! glob pattern', () => {
      const zipFileName = getTestArtifactFileName('re-include-with-globs');

      packagePlugin.exclude = [
        'event.json',
        'lib/**',
        'node_modules/directory-1/**',

        '!event.json', // re-include
        '!lib/**', // re-include
      ];
      packagePlugin.include = [];
      packagePlugin.zipFileName = zipFileName;

      return expect(packagePlugin.zip()).to.eventually.be
        .equal(path.join(serverless.config.servicePath, '.serverless', zipFileName))
      .then(artifact => {
        const data = fs.readFileSync(artifact);
        return expect(zip.loadAsync(data)).to.be.fulfilled;
      }).then(unzippedData => {
        const unzippedFileData = unzippedData.files;

        expect(Object.keys(unzippedFileData)
          .filter(file => !unzippedFileData[file].dir))
          .to.be.lengthOf(11);

        // root directory
        expect(unzippedFileData['event.json'].name)
          .to.equal('event.json');
        expect(unzippedFileData['handler.js'].name)
          .to.equal('handler.js');
        expect(unzippedFileData['file-1'].name)
          .to.equal('file-1');
        expect(unzippedFileData['file-2'].name)
          .to.equal('file-2');

        // bin directory
        expect(unzippedFileData['bin/binary-777'].name)
          .to.equal('bin/binary-777');
        expect(unzippedFileData['bin/binary-444'].name)
          .to.equal('bin/binary-444');

        // lib directory
        expect(unzippedFileData['lib/file-1.js'].name)
          .to.equal('lib/file-1.js');
        expect(unzippedFileData['lib/directory-1/file-1.js'].name)
          .to.equal('lib/directory-1/file-1.js');

        // node_modules directory
        expect(unzippedFileData['node_modules/directory-2/file-1'].name)
          .to.equal('node_modules/directory-2/file-1');
        expect(unzippedFileData['node_modules/directory-2/file-2'].name)
          .to.equal('node_modules/directory-2/file-2');
      });
    });

    it('should re-include files using include config', () => {
      const zipFileName = getTestArtifactFileName('re-include-with-include');

      packagePlugin.exclude = [
        'event.json',
        'lib/**',
        'node_modules/directory-1/**',
      ];
      packagePlugin.include = [
        'event.json',
        'lib/**',
      ];
      packagePlugin.zipFileName = zipFileName;

      return expect(packagePlugin.zip()).to.eventually.be
        .equal(path.join(serverless.config.servicePath, '.serverless', zipFileName))
      .then(artifact => {
        const data = fs.readFileSync(artifact);
        return expect(zip.loadAsync(data)).to.be.fulfilled;
      }).then(unzippedData => {
        const unzippedFileData = unzippedData.files;

        expect(Object.keys(unzippedFileData)
          .filter(file => !unzippedFileData[file].dir))
          .to.be.lengthOf(11);

        // root directory
        expect(unzippedFileData['event.json'].name)
          .to.equal('event.json');
        expect(unzippedFileData['handler.js'].name)
          .to.equal('handler.js');
        expect(unzippedFileData['file-1'].name)
          .to.equal('file-1');
        expect(unzippedFileData['file-2'].name)
          .to.equal('file-2');

        // bin directory
        expect(unzippedFileData['bin/binary-777'].name)
          .to.equal('bin/binary-777');
        expect(unzippedFileData['bin/binary-444'].name)
          .to.equal('bin/binary-444');

        // lib directory
        expect(unzippedFileData['lib/file-1.js'].name)
          .to.equal('lib/file-1.js');
        expect(unzippedFileData['lib/directory-1/file-1.js'].name)
          .to.equal('lib/directory-1/file-1.js');

        // node_modules directory
        expect(unzippedFileData['node_modules/directory-2/file-1'].name)
          .to.equal('node_modules/directory-2/file-1');
        expect(unzippedFileData['node_modules/directory-2/file-2'].name)
          .to.equal('node_modules/directory-2/file-2');
      });
    });

    it('should throw an error if no files are matched', () => {
      packagePlugin.exclude = ['**/**'];
      packagePlugin.include = [];
      packagePlugin.zipFileName = getTestArtifactFileName('empty');

      return expect(packagePlugin.zip()).to.be
        .rejectedWith(Error, 'file matches include / exclude');
    });
  });
});
