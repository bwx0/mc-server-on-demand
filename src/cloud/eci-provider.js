function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function eciVolumeParams(config) {
  if (config.storage.mode === 'nas') {
    return {
      'Volume.1.Name': 'mc-data',
      'Volume.1.Type': 'NFSVolume',
      'Volume.1.NFSVolume.Server': config.storage.nasServer,
      'Volume.1.NFSVolume.Path': config.storage.nasPath,
      'Volume.1.NFSVolume.ReadOnly': false,
    };
  }

  const options = config.storage.eciFlexOptionsJson
    ? JSON.parse(config.storage.eciFlexOptionsJson)
    : {
        volumeId: config.storage.diskId,
        deleteWithInstance: 'false',
      };

  return {
    'Volume.1.Name': 'mc-data',
    'Volume.1.Type': 'FlexVolume',
    'Volume.1.FlexVolume.Driver': 'alicloud/disk',
    'Volume.1.FlexVolume.FsType': 'ext4',
    'Volume.1.FlexVolume.Options': JSON.stringify(options),
  };
}

function commandParams(command) {
  if (!command) return {};
  return {
    'Container.1.Command.1': '/bin/bash',
    'Container.1.Arg.1': '-lc',
    'Container.1.Arg.2': command,
  };
}

// Builds Container.1.EnvironmentVar.N.Key/Value params from a list, skipping empty values.
function envParams(envVars) {
  const params = {};
  let index = 1;
  for (const { key, value } of envVars) {
    if (value === undefined || value === null || value === '') continue;
    params[`Container.1.EnvironmentVar.${index}.Key`] = key;
    params[`Container.1.EnvironmentVar.${index}.Value`] = String(value);
    index += 1;
  }
  return params;
}

function normalRuntimeEnv(config, savePath) {
  const envVars = [
    { key: 'RUNTIME_TOKEN', value: config.app.runtimeToken },
    { key: 'CONTROL_PLANE_URL', value: config.app.publicBaseUrl },
    { key: 'MC_SAVE_SUBDIR', value: savePath },
    { key: 'MINECRAFT_RCON_PORT', value: String(config.runtime.rconPort) },
    { key: 'MINECRAFT_RCON_PASSWORD', value: config.runtime.rconPassword },
    { key: 'MONITOR_INTERVAL_MS', value: String(config.runtime.monitorIntervalMs) },
    { key: 'MONITOR_DEBUG', value: String(config.runtime.monitorDebug) },
    { key: 'IDLE_AUTO_STOP', value: String(config.runtime.idleAutoStop) },
    { key: 'IDLE_STOP_MINUTES', value: String(config.runtime.idleStopMinutes) },
    { key: 'LOCAL_STOP_EXIT_GRACE_SECONDS', value: String(config.runtime.localStopExitGraceSeconds) },
  ];
  if (config.runtime.promPushgatewayUrl) {
    envVars.push(
      { key: 'PROM_PUSHGATEWAY_URL', value: config.runtime.promPushgatewayUrl },
      { key: 'PROM_PUSH_INTERVAL_MS', value: String(config.runtime.promPushIntervalMs) },
      { key: 'PROM_PUSH_METHOD', value: config.runtime.promPushMethod },
      { key: 'PROM_JOB', value: config.runtime.promJob },
      { key: 'PROM_SERVER_LABEL', value: config.runtime.promServerLabel },
    );
  }
  return envVars;
}

// Maintenance image (ssh/python/nginx) gets no monitor/RCON/prom env; just the data path,
// nginx mapping and optional SSH credentials. envParams() drops empty values automatically.
function maintenanceRuntimeEnv(config) {
  return [
    { key: 'MAINTENANCE_MODE', value: 'true' },
    { key: 'DATA_DIR', value: config.storage.mountPath },
    { key: 'MAINTENANCE_NGINX_PATH', value: config.runtime.maintenanceNginxPath },
    { key: 'MAINTENANCE_TIMEOUT_MINUTES', value: String(config.runtime.maintenanceTimeoutMinutes) },
    { key: 'SSH_ROOT_PASSWORD', value: config.runtime.maintenanceSshPassword },
    { key: 'SSH_AUTHORIZED_KEYS', value: config.runtime.maintenanceSshAuthorizedKeys },
  ];
}

function isNotFound(error) {
  const message = String(error?.message ?? '');
  const code = String(error?.code ?? error?.Code ?? '');
  return code.includes('NotFound')
    || code.includes('NotExist')
    || message.includes('does not exist')
    || message.includes('ContainerGroupId');
}

export class EciProvider {
  constructor(config, pop) {
    this.config = config;
    this.pop = pop;
  }

  async createRuntime(options = {}) {
    const mode = options.mode ?? 'normal';
    const isMaintenance = mode === 'maintenance';
    const savePath = options.savePath ?? this.config.runtime.defaultSavePath;

    const image = isMaintenance ? this.config.runtime.maintenanceImage : this.config.runtime.image;
    if (isMaintenance && !image) {
      throw new Error('MAINTENANCE_IMAGE is required to start the maintenance/recovery runtime.');
    }
    const command = isMaintenance ? this.config.runtime.maintenanceCommand : this.config.runtime.command;
    const envVars = isMaintenance
      ? maintenanceRuntimeEnv(this.config)
      : normalRuntimeEnv(this.config, savePath);

    const name = `${this.config.runtime.namePrefix}-${isMaintenance ? 'maint-' : ''}${Date.now()}`;
    const response = await this.pop.eci('CreateContainerGroup', compact({
      ZoneId: this.config.aliyun.zoneId,
      VSwitchId: this.config.aliyun.vSwitchId,
      SecurityGroupId: this.config.aliyun.securityGroupId,
      ContainerGroupName: name,
      Cpu: this.config.runtime.cpu,
      Memory: this.config.runtime.memory,
      RestartPolicy: this.config.runtime.restartPolicy,
      EipInstanceId: this.config.aliyun.eipInstanceId,
      ResourceGroupId: this.config.aliyun.resourceGroupId,
      'Container.1.Name': isMaintenance ? 'maintenance' : 'minecraft',
      'Container.1.Image': image,
      'Container.1.ImagePullPolicy': this.config.runtime.imagePullPolicy,
      'Container.1.Port.1.Port': this.config.runtime.minecraftPort,
      'Container.1.Port.1.Protocol': 'TCP',
      'Container.1.VolumeMount.1.Name': 'mc-data',
      'Container.1.VolumeMount.1.MountPath': this.config.storage.mountPath,
      ...envParams(envVars),
      ...commandParams(command),
      ...eciVolumeParams(this.config),
      ...this.pop.tags(),
    }));

    return {
      provider: 'eci',
      runtimeId: response.ContainerGroupId,
      runtimeName: name,
      mode,
      savePath: isMaintenance ? null : savePath,
      raw: response,
    };
  }

  async describeRuntime(runtimeId) {
    if (!runtimeId) return null;
    let response;
    try {
      response = await this.pop.eci('DescribeContainerGroups', {
        ContainerGroupIds: JSON.stringify([runtimeId]),
      });
    } catch (error) {
      if (isNotFound(error)) {
        return { missing: true, runtimeId };
      }
      throw error;
    }
    let groups = response.ContainerGroups;
    if (groups && !Array.isArray(groups)) {
      groups = groups.ContainerGroup;
    }
    const group = Array.isArray(groups) && groups.length > 0 ? groups[0] : null;
    
    // Deleted groups sometimes disappear from the API with HTTP 200 and an empty list.
    if (!group) {
      return { missing: true, runtimeId };
    }
    return group;
  }

  async deleteRuntime(runtimeId) {
    if (!runtimeId) return null;
    try {
      return await this.pop.eci('DeleteContainerGroup', {
        ContainerGroupId: runtimeId,
      });
    } catch (error) {
      if (isNotFound(error)) {
        return { missing: true, runtimeId };
      }
      throw error;
    }
  }
}
