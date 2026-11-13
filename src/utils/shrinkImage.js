/**
 * ย่อรูปก่อนส่งขึ้นเซิร์ฟเวอร์ — คืน data URI แบบ JPEG ที่ด้านยาวไม่เกิน maxSide px
 *
 * ไฟล์ส่งเป็น base64 ผ่าน Vercel ซึ่งรับ body ได้ไม่เกิน ~4.5 MB ต่อครั้ง รูปจากมือถือมักใหญ่ 3-5 MB
 * (base64 โตขึ้นอีกราว 1/3) ส่งตรง ๆ จะล้มด้วย error เน็ตกลาง ๆ ที่ผู้ใช้อ่านไม่ออก
 * คืน null เมื่อไม่ใช่รูป/ย่อไม่ได้ — ให้ผู้เรียกส่งไฟล์เดิมไปแทน
 */
export default function shrinkImage(file, { maxSide = 1600, quality = 0.82 } = {}) {
  return new Promise((resolve) => {
    if (!file?.type?.startsWith('image/') || file.type === 'image/gif') { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
