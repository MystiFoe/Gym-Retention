// ignore_for_file: constant_identifier_names
// Stub for razorpay_flutter on web — mirrors the real API so the code compiles.
// None of these methods do anything; the subscription_screen shows a web-only
// UI instead of the Razorpay flow when kIsWeb is true.

class Razorpay {
  static const String EVENT_PAYMENT_SUCCESS  = 'payment.success';
  static const String EVENT_PAYMENT_ERROR    = 'payment.error';
  static const String EVENT_EXTERNAL_WALLET  = 'payment.external_wallet';

  void on(String event, Function handler) {}
  void open(Map<String, dynamic> options) {}
  void clear() {}
}

class PaymentSuccessResponse {
  final String? paymentId;
  final String? orderId;
  final String? signature;
  PaymentSuccessResponse(this.paymentId, this.orderId, this.signature);
}

class PaymentFailureResponse {
  final int?    code;
  final String? message;
  PaymentFailureResponse(this.code, this.message);
}

class ExternalWalletResponse {
  final String? walletName;
  ExternalWalletResponse(this.walletName);
}
