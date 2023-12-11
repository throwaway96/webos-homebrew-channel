#!/usr/bin/env node

import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { dirname, resolve } from 'path';

process.env['PATH'] = `/usr/sbin:${process.env['PATH']}`;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (err) {
    return false;
  }
}

function parentExists(path: string): boolean {
  try {
    return statSync(dirname(path)).isDirectory();
  } catch (err) {
    return false;
  }
}

function patchServiceFile(serviceFile: string): boolean {
  const serviceFileOriginal = readFileSync(serviceFile).toString();
  let serviceFileNew = serviceFileOriginal;

  if (serviceFileNew.indexOf('/run-js-service') !== -1) {
    console.info(`[ ] ${serviceFile} is a JS service`);

    // run-js-service should be in the same directory as this script.
    const runJsServicePath = resolve(__dirname, 'run-js-service');

    if (!existsSync(runJsServicePath)) {
      console.error(`[!] run-js-service does not exist at ${runJsServicePath}`);
      return false;
    }

    serviceFileNew = serviceFileNew.replace(/^Exec=\/usr\/bin\/run-js-service/gm, `Exec=${runJsServicePath}`);
  } else if (serviceFileNew.indexOf('/jailer') !== -1) {
    console.info(`[ ] ${serviceFile} is a native service`);
    serviceFileNew = serviceFileNew.replace(/^Exec=\/usr\/bin\/jailer .* ([^ ]*)$/gm, (_, binaryPath) => `Exec=${binaryPath}`);
  } else if (serviceFileNew.indexOf('Exec=/media') === -1) {
    // Ignore elevated native services...
    console.info(`[~] ${serviceFile}: unknown service type, this may cause some troubles`);
  }

  if (serviceFileNew !== serviceFileOriginal) {
    console.info(`[ ] Updating service definition: ${serviceFile}`);
    console.info('-', serviceFileOriginal);
    console.info('+', serviceFileNew);
    writeFileSync(serviceFile, serviceFileNew);
    return true;
  }
  return false;
}

function patchRolesFile(path: string, requiredNames: string[] = ['*', 'com.webos.service.capture.client*']) {
  const rolesOriginal = readFileSync(path).toString();
  const rolesNew = JSON.parse(rolesOriginal);

  for (const name of requiredNames) {
    // webOS <4.x /var/ls2-dev role file
    if (rolesNew?.role?.allowedNames && rolesNew?.role?.allowedNames.indexOf(name) === -1) {
      rolesNew.role.allowedNames.push(name);
    }

    // webOS 4.x+ /var/luna-service2 role file
    if (rolesNew?.allowedNames && rolesNew?.allowedNames.indexOf(name) === -1) {
      rolesNew.allowedNames.push(name);
    }
  }

  // permissions / allowedNames interactions are fairly odd. It seems like
  // "service" field in permission is one of allowedNames that this executable
  // can use, outbound are remote client names that our executable/name can use,
  // and inbound are remote client names that can access our executable.
  //
  // Oddly, even though there seems to be some support for wildcards, some
  // pieces of software verify explicit permission "service" key, thus we
  // sometimes may need some extra allowedNames/permissions, even though we
  // default to "*"
  if (rolesNew.permissions) {
    const missingPermissionNames = requiredNames;
    rolesNew.permissions.forEach((perm: { outbound?: string[]; service?: string }) => {
      if (perm.service && missingPermissionNames.indexOf(perm.service) !== -1)
        missingPermissionNames.splice(missingPermissionNames.indexOf(perm.service), 1);
      if (perm.outbound && perm.outbound.indexOf('*') === -1) {
        perm.outbound.push('*');
      }
    });

    for (const name of missingPermissionNames) {
      console.info(`[ ] Adding permission for name: ${name}`);
      rolesNew.permissions.push({
        service: name,
        inbound: ['*'],
        outbound: ['*'],
      });
    }
  }

  const rolesNewContents = JSON.stringify(rolesNew);
  if (rolesNewContents !== JSON.stringify(JSON.parse(rolesOriginal))) {
    console.info(`[ ] Updating roles definition: ${path}`);
    console.info('-', rolesOriginal);
    console.info('+', rolesNewContents);
    writeFileSync(path, rolesNewContents);
    return true;
  }

  return false;
}

function main(argv: string[]) {
  let [serviceName = 'org.webosbrew.hbchannel.service', appName = serviceName.split('.').slice(0, -1).join('.')] = argv;

  if (serviceName === 'org.webosbrew.hbchannel') {
    serviceName = 'org.webosbrew.hbchannel.service';
    appName = 'org.webosbrew.hbchannel';
  }

  let configChanged = false;

  function searchDir(lunaRoot: string): void {
    const serviceFile = `${lunaRoot}/services.d/${serviceName}.service`;
    const clientPermFile = `${lunaRoot}/client-permissions.d/${serviceName}.root.json`;
    const apiPermFile = `${lunaRoot}/api-permissions.d/${serviceName}.api.public.json`;
    const manifestFile = `${lunaRoot}/manifests.d/${appName}.json`;
    const roleFile = `${lunaRoot}/roles.d/${serviceName}.service.json`;

    if (isFile(serviceFile)) {
      console.info(`[~] Found webOS 3.x+ service file: ${serviceFile}`);
      if (patchServiceFile(serviceFile)) {
        configChanged = true;
      }
    } else {
      // Skip everything else if service file is not found.
      return;
    }

    if (parentExists(clientPermFile) && !isFile(clientPermFile)) {
      console.info(`[ ] Creating client permissions file: ${clientPermFile}`);
      writeFileSync(
        clientPermFile,
        JSON.stringify({
          [`${serviceName}*`]: ['all'],
        }),
      );
      configChanged = true;
    }

    if (parentExists(apiPermFile) && !isFile(apiPermFile)) {
      console.info(`[ ] Creating API permissions file: ${apiPermFile}`);
      writeFileSync(
        apiPermFile,
        JSON.stringify({
          public: [`${serviceName}/*`],
        }),
      );
      configChanged = true;
    }

    if (isFile(roleFile)) {
      if (patchRolesFile(roleFile)) {
        configChanged = true;
      }
    }

    if (isFile(manifestFile)) {
      console.info(`[~] Found webOS 4.x+ manifest file: ${manifestFile}`);
      const manifestFileOriginal = readFileSync(manifestFile).toString();
      const manifestFileParsed = JSON.parse(manifestFileOriginal);
      if (manifestFileParsed.clientPermissionFiles && manifestFileParsed.clientPermissionFiles.indexOf(clientPermFile) === -1) {
        console.info('[ ] manifest - adding client permissions file...');
        manifestFileParsed.clientPermissionFiles.push(clientPermFile);
      }

      if (manifestFileParsed.apiPermissionFiles && manifestFileParsed.apiPermissionFiles.indexOf(apiPermFile) === -1) {
        console.info('[ ] manifest - adding API permissions file...');
        manifestFileParsed.apiPermissionFiles.push(apiPermFile);
      }

      const manifestFileNew = JSON.stringify(manifestFileParsed);
      if (manifestFileNew !== manifestFileOriginal) {
        console.info(`[~] Updating manifest file: ${manifestFile}`);
        console.info('-', manifestFileOriginal);
        console.info('+', manifestFileNew);
        writeFileSync(manifestFile, manifestFileNew);
        configChanged = true;
      }
    }
  }

  searchDir('/var/luna-service2-dev');
  searchDir('/var/luna-service2');

  function searchLegacyDir(legacyLunaRoot: string): void {
    const legacyPubServiceFile = `${legacyLunaRoot}/services/pub/${serviceName}.service`;
    const legacyPrvServiceFile = `${legacyLunaRoot}/services/prv/${serviceName}.service`;
    const legacyPubRolesFile = `${legacyLunaRoot}/roles/pub/${serviceName}.json`;
    const legacyPrvRolesFile = `${legacyLunaRoot}/roles/prv/${serviceName}.json`;

    if (isFile(legacyPubServiceFile)) {
      console.info(`[~] Found legacy webOS <3.x service file: ${legacyPubServiceFile}`);
      if (patchServiceFile(legacyPubServiceFile)) {
        configChanged = true;
      }

      if (isFile(legacyPrvServiceFile)) {
        if (patchServiceFile(legacyPrvServiceFile)) {
          configChanged = true;
        }
      } else {
        console.warn(`[!] Did not find legacy private service file: ${legacyPrvServiceFile}`);
      }
    }

    if (isFile(legacyPubRolesFile)) {
      if (patchRolesFile(legacyPubRolesFile)) {
        configChanged = true;
      }
    }

    if (isFile(legacyPrvRolesFile)) {
      if (patchRolesFile(legacyPrvRolesFile)) {
        configChanged = true;
      }
    }
  }

  searchLegacyDir('/var/palm/ls2-dev');
  searchLegacyDir('/var/palm/ls2');

  if (configChanged) {
    console.info('[+] Refreshing services...');
    execFile('ls-control', ['scan-services'], { timeout: 10000 }, (err, stderr, stdout) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      if (stdout) console.info(stdout);
      if (stderr) console.info(stderr);
      process.exit(0);
    });
  } else {
    console.info('[-] No changes, no rescan needed');
  }
}

main(process.argv.slice(2));
