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

function promEnvParams(config, startIndex) {
  if (!config.runtime.promPushgatewayUrl) return {};
  return {
    [`Container.1.EnvironmentVar.${startIndex}.Key`]: 'PROM_PUSHGATEWAY_URL',
    [`Container.1.EnvironmentVar.${startIndex}.Value`]: config.runtime.promPushgatewayUrl,
    [`Container.1.EnvironmentVar.${startIndex + 1}.Key`]: 'PROM_PUSH_INTERVAL_MS',
    [`Container.1.EnvironmentVar.${startIndex + 1}.Value`]: String(config.runtime.promPushIntervalMs),
    [`Container.1.EnvironmentVar.${startIndex + 2}.Key`]: 'PROM_JOB',
    [`Container.1.EnvironmentVar.${startIndex + 2}.Value`]: config.runtime.promJob,
    [`Container.1.EnvironmentVar.${startIndex + 3}.Key`]: 'PROM_SERVER_LABEL',
    [`Container.1.EnvironmentVar.${startIndex + 3}.Value`]: config.runtime.promServerLabel,
  };
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

  async createRuntime() {
    const name = `${this.config.runtime.namePrefix}-${Date.now()}`;
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
      'Container.1.Name': 'minecraft',
      'Container.1.Image': this.config.runtime.image,
      'Container.1.ImagePullPolicy': 'IfNotPresent',
      'Container.1.Port.1.Port': this.config.runtime.minecraftPort,
      'Container.1.Port.1.Protocol': 'TCP',
      'Container.1.VolumeMount.1.Name': 'mc-data',
      'Container.1.VolumeMount.1.MountPath': this.config.storage.mountPath,
      'Container.1.EnvironmentVar.1.Key': 'RUNTIME_TOKEN',
      'Container.1.EnvironmentVar.1.Value': this.config.app.runtimeToken,
      'Container.1.EnvironmentVar.2.Key': 'CONTROL_PLANE_URL',
      'Container.1.EnvironmentVar.2.Value': this.config.app.publicBaseUrl,
      'Container.1.EnvironmentVar.3.Key': 'MINECRAFT_RCON_PORT',
      'Container.1.EnvironmentVar.3.Value': String(this.config.runtime.rconPort),
      'Container.1.EnvironmentVar.4.Key': 'MINECRAFT_RCON_PASSWORD',
      'Container.1.EnvironmentVar.4.Value': this.config.runtime.rconPassword,
      'Container.1.EnvironmentVar.5.Key': 'MONITOR_INTERVAL_MS',
      'Container.1.EnvironmentVar.5.Value': String(this.config.runtime.monitorIntervalMs),
      'Container.1.EnvironmentVar.6.Key': 'MONITOR_DEBUG',
      'Container.1.EnvironmentVar.6.Value': String(this.config.runtime.monitorDebug),
      'Container.1.EnvironmentVar.7.Key': 'IDLE_AUTO_STOP',
      'Container.1.EnvironmentVar.7.Value': String(this.config.runtime.idleAutoStop),
      'Container.1.EnvironmentVar.8.Key': 'IDLE_STOP_MINUTES',
      'Container.1.EnvironmentVar.8.Value': String(this.config.runtime.idleStopMinutes),
      'Container.1.EnvironmentVar.9.Key': 'LOCAL_STOP_EXIT_GRACE_SECONDS',
      'Container.1.EnvironmentVar.9.Value': String(this.config.runtime.localStopExitGraceSeconds),
      ...promEnvParams(this.config, 10),
      ...commandParams(this.config.runtime.command),
      ...eciVolumeParams(this.config),
      ...this.pop.tags(),
    }));

    return {
      provider: 'eci',
      runtimeId: response.ContainerGroupId,
      runtimeName: name,
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
    const groups = response.ContainerGroups?.ContainerGroup ?? [];
    return Array.isArray(groups) ? groups[0] ?? null : groups;
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
