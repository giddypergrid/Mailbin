import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sun.mailbin',
  appName: 'Mailbin',
  webDir: 'dist',
  server: { androidScheme: 'https', url: 'http://10.40.205.49:5174', cleartext: true }
};

export default config;

