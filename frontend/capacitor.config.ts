import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sun.mailbin',
  appName: 'Mailbin',
  webDir: 'dist',
  server: { androidScheme: 'https' }
};

export default config;



