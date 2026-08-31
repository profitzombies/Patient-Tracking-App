import fs from 'fs';
import path from 'path';

const appPath = path.resolve(process.cwd(), 'src/App.tsx');
const emailStudioPath = path.resolve(process.cwd(), 'src/pages/EmailStudio.tsx');

let success = true;

if (!fs.existsSync(emailStudioPath)) {
  console.error('❌ EmailStudio.tsx not found');
  success = false;
} else {
  const content = fs.readFileSync(emailStudioPath, 'utf8');
  if (!content.includes('@workspace/email-templates')) {
    console.error('❌ EmailStudio does not import @workspace/email-templates');
    success = false;
  }
  if (!content.includes('TabsContent value="mobile"')) {
    console.error('❌ EmailStudio missing mobile preview tab');
    success = false;
  }
  if (!content.includes("status === 'failed' ? 'Couldn’t copy'")) {
    console.error('❌ EmailStudio missing visible clipboard failure feedback');
    success = false;
  }
  if (!content.includes('preview.previewText')) {
    console.error('❌ EmailStudio does not display the generated inbox preview');
    success = false;
  }
  if (/\bfetch\s*\(|use[A-Z]\w*Query\s*\(/.test(content)) {
    console.error('❌ Public EmailStudio must not fetch application or recipient data');
    success = false;
  }
}

const appContent = fs.readFileSync(appPath, 'utf8');
if (!appContent.includes('<Route path="/email" component={EmailStudio} />')) {
  console.error('❌ App.tsx does not mount /email route');
  success = false;
}

if (success) {
  console.log('✅ Email Studio verified');
  process.exit(0);
} else {
  process.exit(1);
}
