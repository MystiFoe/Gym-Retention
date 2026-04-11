// Cross-platform file download / save helper.
// On web    → triggers a browser download via package:web.
// On mobile → saves to temp dir then opens the OS share sheet.
export 'file_download_stub.dart'
    if (dart.library.html) 'file_download_web.dart'
    if (dart.library.io) 'file_download_native.dart';
