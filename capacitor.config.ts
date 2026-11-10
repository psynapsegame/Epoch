import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.psynapse.epoch',
  appName: 'EPOCH',
  webDir: 'dist',
  backgroundColor: '#07080a',
  ios: { contentInset: 'never', backgroundColor: '#07080a', scrollEnabled: false },
  android: { backgroundColor: '#07080a' },
};

export default config;
