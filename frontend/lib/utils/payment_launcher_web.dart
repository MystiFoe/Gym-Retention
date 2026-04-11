import 'dart:js_interop';
import 'dart:js_interop_unsafe';

typedef PaymentSuccessCallback = void Function(String paymentId, String orderId, String signature);
typedef PaymentFailureCallback = void Function(String message);

@JS('openRazorpayCheckout')
external void _openRazorpayCheckout(
  JSObject options,
  JSFunction onSuccess,
  JSFunction onFailure,
);

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
  final options = JSObject();
  options['key_id'] = keyId.toJS;
  options['amount'] = amount.toJS;
  options['currency'] = currency.toJS;
  options['order_id'] = orderId.toJS;
  options['gym_name'] = gymName.toJS;
  options['plan_label'] = planLabel.toJS;

  void successFn(JSString pid, JSString oid, JSString sig) {
    onSuccess(pid.toDart, oid.toDart, sig.toDart);
  }

  void failureFn(JSString msg) {
    onFailure(msg.toDart);
  }

  _openRazorpayCheckout(options, successFn.toJS, failureFn.toJS);
}
