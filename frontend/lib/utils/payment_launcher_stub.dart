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
  throw UnsupportedError('Razorpay is not supported on this platform');
}
