# ویزارد استقرار مِهر (Mehr Wizard)

ابزار رسمی و تحت وب برای استقرار، پیکربندی پایگاه‌داده و مدیریت نودهای کلاستر مِهر روی ورکر کلودفلر.

---

## 🚀 راهنمای راه‌اندازی سریع

### ۱. پیش‌نیازها
* داشتن یک حساب فعال در Cloudflare.
* ساخت یک توکن API در بخش My Profile > API Tokens با دسترسی‌های:
  - Workers Scripts (Edit)
  - Workers KV Storage (Edit)
  - D1 (Edit)

### ۲. استقرار ویزارد روی ورکر
دستورات زیر را در ترمینال اجرا کنید:

git clone https://github.com/Reeeza2005/mehr-wizard.git
cd mehr-wizard
export CLOUDFLARE_API_TOKEN="YOUR_API_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="YOUR_ACCOUNT_ID"
npx wrangler deploy

پس از اتمام، آدرس ورکر نمایش داده می‌شود (مانند https://mehr-wizard.subdomain.workers.dev).

---

## 📖 نحوه استفاده از محیط وب
۱. آدرس ورکر را در مرورگر باز کنید.
۲. توکن کلودفلر خود را وارد کرده و اعتبارسنجی را بزنید.
۳. نقش مورد نظر را انتخاب کنید:
   - Master Panel: استقرار خودکار پنل مدیریت مِهر و ساخت پایگاه‌داده ابری D1.
   - Edge Node: ساخت نود ترافیکی سبک BPB و دریافت آدرس و کلید اتصال برای ثبت در پنل.
