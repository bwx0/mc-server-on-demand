import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const name = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    if (name && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function required(name) {
  const value = env(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberEnv(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
}

function boolEnv(name, fallback = false) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function csvEnv(name, fallback = []) {
  const raw = env(name);
  if (!raw) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export function loadConfig() {
  loadDotEnv();
  const dataDir = env('DATA_DIR', path.join(process.cwd(), 'data'));

  return {
    app: {
      host: env('HOST', '0.0.0.0'),
      port: numberEnv('PORT', 3000),
      publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:3000'),
      stateFile: env('STATE_FILE', path.join(dataDir, 'state.json')),
      auditFile: env('AUDIT_FILE', path.join(dataDir, 'audit.log')),
      controlToken: env('CONTROL_TOKEN', 'change-me-before-public-use'),
      runtimeToken: env('RUNTIME_TOKEN', 'change-me-runtime-token'),
      lockTimeoutMs: numberEnv('LOCK_TIMEOUT_MS', 15 * 60 * 1000),
    },
    aliyun: {
      accessKeyId: required('ALIYUN_ACCESS_KEY_ID'),
      accessKeySecret: required('ALIYUN_ACCESS_KEY_SECRET'),
      regionId: required('ALIYUN_REGION_ID'),
      zoneId: required('ALIYUN_ZONE_ID'),
      vSwitchId: required('ALIYUN_VSWITCH_ID'),
      securityGroupId: required('ALIYUN_SECURITY_GROUP_ID'),
      eipInstanceId: required('ALIYUN_EIP_INSTANCE_ID'),
      eipAddress: env('ALIYUN_EIP_ADDRESS'),
      resourceGroupId: env('ALIYUN_RESOURCE_GROUP_ID'),
      tags: csvEnv('ALIYUN_TAGS', ['app:minecraft-ondemand']),
    },
    runtime: {
      provider: env('RUNTIME_PROVIDER', 'eci'),
      namePrefix: env('RUNTIME_NAME_PREFIX', 'mc-ondemand'),
      cpu: numberEnv('RUNTIME_CPU', 8),
      memory: numberEnv('RUNTIME_MEMORY_GIB', 16),
      image: required('RUNTIME_IMAGE'),
      command: env('RUNTIME_COMMAND', '/entrypoint.sh'),
      restartPolicy: env('RUNTIME_RESTART_POLICY', 'Never'),
      minecraftPort: numberEnv('MINECRAFT_PORT', 25565),
      rconHost: env('MINECRAFT_RCON_HOST', env('ALIYUN_EIP_ADDRESS', '127.0.0.1')),
      rconPort: numberEnv('MINECRAFT_RCON_PORT', 25575),
      rconPassword: env('MINECRAFT_RCON_PASSWORD'),
      stopGraceSeconds: numberEnv('STOP_GRACE_SECONDS', 90),
      idleAlertMinutes: numberEnv('IDLE_ALERT_MINUTES', 5),
      idleAutoStop: boolEnv('IDLE_AUTO_STOP', false),
    },
    storage: {
      mode: env('STORAGE_MODE', 'cloud-disk'),
      mountPath: env('STORAGE_MOUNT_PATH', '/data'),
      diskId: env('ALIYUN_DISK_ID'),
      diskHasPartition: boolEnv('STORAGE_DISK_HAS_PARTITION', false),
      allowPartitionedDiskForEci: boolEnv('ALLOW_ECI_PARTITIONED_DISK', false),
      eciFlexOptionsJson: env('ALIYUN_ECI_FLEX_OPTIONS_JSON'),
      nasServer: env('ALIYUN_NAS_SERVER'),
      nasPath: env('ALIYUN_NAS_PATH', '/'),
    },
    ecsFallback: {
      enabled: boolEnv('ECS_FALLBACK_ENABLED', false),
      imageId: env('ECS_IMAGE_ID'),
      instanceType: env('ECS_INSTANCE_TYPE', 'ecs.g8i.2xlarge'),
      systemDiskCategory: env('ECS_SYSTEM_DISK_CATEGORY', 'cloud_essd'),
      systemDiskSize: numberEnv('ECS_SYSTEM_DISK_SIZE_GIB', 40),
      keyPairName: env('ECS_KEY_PAIR_NAME'),
      instanceChargeType: env('ECS_INSTANCE_CHARGE_TYPE', 'PostPaid'),
    },
    alerts: {
      emailEnabled: boolEnv('ALERT_EMAIL_ENABLED', false),
      smtpHost: env('SMTP_HOST'),
      smtpPort: numberEnv('SMTP_PORT', 587),
      smtpSecure: boolEnv('SMTP_SECURE', false),
      smtpUser: env('SMTP_USER'),
      smtpPassword: env('SMTP_PASSWORD'),
      emailFrom: env('ALERT_EMAIL_FROM'),
      emailTo: csvEnv('ALERT_EMAIL_TO'),
      webhookUrl: env('ALERT_WEBHOOK_URL'),
    },
    host: {
      hostname: os.hostname(),
      nodeEnv: env('NODE_ENV', 'development'),
    },
  };
}
