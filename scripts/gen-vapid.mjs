// Generate a VAPID key pair for Web Push. Run once:  npm run gen-vapid
// Paste the printed values into Netlify environment variables.
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('\nAdd these to your Netlify environment variables:\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('VAPID_SUBJECT=mailto:you@yourdomain.com\n');
