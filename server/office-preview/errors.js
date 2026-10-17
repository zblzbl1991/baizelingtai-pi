// Translate only the reviewed kit's published content/limit/deadline categories
// at its adapter boundary. Unknown runtime faults remain availability failures.
function nativeConversionError(category) {
    const categories = {
        'input-too-large': ['OFFICE_LIMIT', 413],
        'output-too-large': ['OFFICE_LIMIT', 413],
        'invalid-document': ['OFFICE_INVALID', 415],
        'unsupported-format': ['OFFICE_INVALID', 415],
        'invalid-output': ['OFFICE_INVALID', 415],
        timeout: ['OFFICE_TIMEOUT', 504]
    };
    const [code, status] = Object.hasOwn(categories, category) ? categories[category] : ['OFFICE_UNAVAILABLE', 503];
    return Object.assign(new Error('Office conversion failed'), { code, status });
}
module.exports = { nativeConversionError };
