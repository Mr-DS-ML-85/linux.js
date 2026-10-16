// test-minimal.js
import('./dist/index.js').then(async ({ Linux }) => {
  console.log('=== Ultra Minimal Test ===');

  try {
    const linux = await Linux.create({
      memory: 256,
      bootTimeout: 30000,
    });
    console.log('✅ SUCCESS - This should not print');
    await linux.shutdown();
  } catch (e) {
    console.error('\n💥 CRASH DETAILS:');
    console.error('Name:', e?.name);
    console.error('Message:', e?.message);
    console.error('Full string:', String(e));
    
    if (e?.stack) {
      console.error('\nStack:');
      console.error(e.stack);
    }
  }
}).catch(console.error);
