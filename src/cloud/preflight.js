function listify(value, key) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value[key])) return value[key];
  if (value[key]) return [value[key]];
  return [];
}

export async function runPreflight(config, pop) {
  const checks = [];
  const warnings = [];
  const errors = [];

  checks.push({
    name: 'runtime-provider',
    ok: ['eci', 'ecs'].includes(config.runtime.provider),
    detail: `Configured provider: ${config.runtime.provider}`,
  });

  if (config.runtime.provider === 'eci' && config.storage.mode === 'cloud-disk') {
    if (!config.storage.diskId) {
      errors.push('ALIYUN_DISK_ID is required for ECI cloud-disk storage.');
    }
    if (config.storage.diskHasPartition && !config.storage.allowPartitionedDiskForEci) {
      errors.push('ECI FlexVolume does not support disks with existing partitions. Migrate to an unpartitioned disk, use NAS, or switch to ECS fallback.');
    }
  }

  if (config.storage.mode === 'nas' && (!config.storage.nasServer || !config.storage.nasPath)) {
    errors.push('ALIYUN_NAS_SERVER and ALIYUN_NAS_PATH are required for NAS storage.');
  }

  if (config.storage.diskId) {
    try {
      const diskResponse = await pop.ecs('DescribeDisks', {
        DiskIds: JSON.stringify([config.storage.diskId]),
      });
      const disks = listify(diskResponse.Disks, 'Disk');
      const disk = disks[0];
      if (!disk) {
        errors.push(`Disk ${config.storage.diskId} was not found.`);
      } else {
        checks.push({
          name: 'disk-zone',
          ok: disk.ZoneId === config.aliyun.zoneId,
          detail: `Disk zone ${disk.ZoneId}; runtime zone ${config.aliyun.zoneId}`,
        });
        checks.push({
          name: 'disk-status',
          ok: ['Available', 'In_use'].includes(disk.Status),
          detail: `Disk status ${disk.Status}`,
        });
        if (disk.DeleteWithInstance === true || disk.DeleteWithInstance === 'true') {
          warnings.push('Disk is configured to delete with instance; disable DeleteWithInstance before production use.');
        }
      }
    } catch (error) {
      warnings.push(`Could not describe disk: ${error.message}`);
    }
  }

  try {
    const eipResponse = await pop.ecs('DescribeEipAddresses', {
      AllocationId: config.aliyun.eipInstanceId,
    });
    const eips = listify(eipResponse.EipAddresses, 'EipAddress');
    const eip = eips[0];
    if (!eip) {
      errors.push(`EIP ${config.aliyun.eipInstanceId} was not found.`);
    } else {
      checks.push({
        name: 'eip-status',
        ok: ['Available', 'InUse'].includes(eip.Status),
        detail: `EIP status ${eip.Status}; address ${eip.IpAddress}`,
      });
      if (config.aliyun.eipAddress && eip.IpAddress !== config.aliyun.eipAddress) {
        warnings.push(`ALIYUN_EIP_ADDRESS is ${config.aliyun.eipAddress}, but the EIP reports ${eip.IpAddress}.`);
      }
    }
  } catch (error) {
    warnings.push(`Could not describe EIP: ${error.message}`);
  }

  return {
    ok: errors.length === 0 && checks.every((check) => check.ok !== false),
    checks,
    warnings,
    errors,
  };
}
