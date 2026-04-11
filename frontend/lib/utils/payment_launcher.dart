// Cross-platform Razorpay payment launcher.
// On web    → calls the Razorpay JS checkout via dart:js_interop.
// On mobile → uses the razorpay_flutter native SDK.
export 'payment_launcher_stub.dart'
    if (dart.library.html) 'payment_launcher_web.dart'
    if (dart.library.io) 'payment_launcher_native.dart';
