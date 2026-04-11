import 'package:razorpay_flutter/razorpay_flutter.dart';

typedef PaymentSuccessCallback = void Function(String paymentId, String orderId, String signature);
typedef PaymentFailureCallback = void Function(String message);

Future<void> launchRazorpay({
  required String keyId,
  required int amount,
  required String currency,
  required String orderId,
  required String gymName,
  required String planLabel,
  required PaymentSuccessCallback onSuccess,
  required PaymentFailureCallback onFailure,
}) async {
  final razorpay = Razorpay();

  razorpay.on(Razorpay.EVENT_PAYMENT_SUCCESS, (PaymentSuccessResponse resp) {
    razorpay.clear();
    onSuccess(
      resp.paymentId ?? '',
      resp.orderId ?? orderId,
      resp.signature ?? '',
    );
  });

  razorpay.on(Razorpay.EVENT_PAYMENT_ERROR, (PaymentFailureResponse resp) {
    razorpay.clear();
    onFailure(resp.message ?? 'Payment failed');
  });

  razorpay.on(Razorpay.EVENT_EXTERNAL_WALLET, (_) {
    razorpay.clear();
    onFailure('External wallet selected — not supported');
  });

  razorpay.open({
    'key': keyId,
    'amount': amount,
    'currency': currency,
    'order_id': orderId,
    'name': gymName,
    'description': planLabel,
    'prefill': {'contact': '', 'email': ''},
    'external': {'wallets': []},
  });
}
