function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function userData(config) {
  const script = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p ${config.storage.mountPath}
echo "Waiting for attached data disk..."
for i in $(seq 1 60); do
  disk="$(lsblk -ndo NAME,TYPE | awk '$2=="disk"{print "/dev/"$1}' | tail -n 1)"
  if [ -n "$disk" ]; then break; fi
  sleep 5
done
mountpoint -q ${config.storage.mountPath} || mount "$disk" ${config.storage.mountPath}
export CONTROL_PLANE_URL="${config.app.publicBaseUrl}"
export RUNTIME_TOKEN="${config.app.runtimeToken}"
cd ${config.storage.mountPath}
exec ${config.storage.mountPath}/server-init.sh
`;
  return Buffer.from(script).toString('base64');
}

export class EcsProvider {
  constructor(config, pop) {
    this.config = config;
    this.pop = pop;
  }

  async createRuntime() {
    if (!this.config.ecsFallback.enabled && this.config.runtime.provider !== 'ecs') {
      throw new Error('ECS fallback is disabled. Set ECS_FALLBACK_ENABLED=true or RUNTIME_PROVIDER=ecs.');
    }
    if (!this.config.ecsFallback.imageId) {
      throw new Error('ECS_IMAGE_ID is required for ECS runtime.');
    }

    const name = `${this.config.runtime.namePrefix}-${Date.now()}`;
    const run = await this.pop.ecs('RunInstances', compact({
      ImageId: this.config.ecsFallback.imageId,
      InstanceType: this.config.ecsFallback.instanceType,
      SecurityGroupId: this.config.aliyun.securityGroupId,
      VSwitchId: this.config.aliyun.vSwitchId,
      ZoneId: this.config.aliyun.zoneId,
      InstanceName: name,
      HostName: name,
      Amount: 1,
      InstanceChargeType: this.config.ecsFallback.instanceChargeType,
      InternetChargeType: 'PayByTraffic',
      SystemDiskCategory: this.config.ecsFallback.systemDiskCategory,
      SystemDiskSize: this.config.ecsFallback.systemDiskSize,
      KeyPairName: this.config.ecsFallback.keyPairName,
      UserData: userData(this.config),
      ...this.pop.tags('Tag'),
    }));
    const instanceId = run.InstanceIdSets?.InstanceIdSet?.[0];
    if (!instanceId) {
      throw new Error('RunInstances did not return an instance id.');
    }

    if (this.config.storage.diskId) {
      await this.pop.ecs('AttachDisk', {
        InstanceId: instanceId,
        DiskId: this.config.storage.diskId,
        DeleteWithInstance: false,
      });
    }

    await this.pop.ecs('AssociateEipAddress', {
      AllocationId: this.config.aliyun.eipInstanceId,
      InstanceId: instanceId,
      InstanceType: 'EcsInstance',
    });

    return {
      provider: 'ecs',
      runtimeId: instanceId,
      runtimeName: name,
      raw: run,
    };
  }

  async describeRuntime(runtimeId) {
    if (!runtimeId) return null;
    const response = await this.pop.ecs('DescribeInstances', {
      InstanceIds: JSON.stringify([runtimeId]),
    });
    const instances = response.Instances?.Instance ?? [];
    const instance = Array.isArray(instances) ? instances[0] ?? null : instances;
    if (!instance) {
      return { missing: true, runtimeId };
    }
    return instance;
  }

  async deleteRuntime(runtimeId) {
    if (!runtimeId) return null;
    try {
      await this.pop.ecs('UnassociateEipAddress', {
        AllocationId: this.config.aliyun.eipInstanceId,
        InstanceId: runtimeId,
        InstanceType: 'EcsInstance',
      });
    } catch (error) {
      if (!String(error.message).includes('InvalidAssociation.NotFound')) {
        throw error;
      }
    }
    try {
      return await this.pop.ecs('DeleteInstance', {
        InstanceId: runtimeId,
        Force: true,
      });
    } catch (error) {
      if (ecsInstanceNotFound(error)) {
        return { missing: true, runtimeId };
      }
      throw error;
    }
  }
}

function ecsInstanceNotFound(error) {
  const message = String(error?.message ?? '');
  const code = String(error?.code ?? error?.Code ?? '');
  return code.includes('NotFound')
    || /InvalidInstanceId/i.test(code)
    || message.includes('does not exist')
    || /InvalidInstanceId/i.test(message);
}
