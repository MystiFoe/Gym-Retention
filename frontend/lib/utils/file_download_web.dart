import 'dart:js_interop';
import 'package:web/web.dart' as web;

Future<void> downloadFile(List<int> bytes, String filename, String mimeType) async {
  final jsArray = bytes.map((b) => b.toJS).toList().toJS;
  final blob = web.Blob(jsArray, web.BlobPropertyBag(type: mimeType));
  final url = web.URL.createObjectURL(blob);
  final anchor = web.document.createElement('a') as web.HTMLAnchorElement
    ..href = url
    ..download = filename;
  web.document.body!.append(anchor);
  anchor.click();
  anchor.remove();
  web.URL.revokeObjectURL(url);
}
