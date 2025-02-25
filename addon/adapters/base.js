import { keys } from '@ember/polyfills';
import RSVP from 'rsvp';
import { run } from '@ember/runloop';
import { isEmpty, typeOf } from '@ember/utils';
import { computed, get } from '@ember/object';
import JSONAPIAdapter from '@ember-data/adapter/json-api';
import ImportExportMixin from '../mixins/adapters/import-export';
import { _buildKey } from '../helpers/storage';

const getKeys = Object.keys || keys;

// Ember data ships with ember-inflector
import { singularize, pluralize } from 'ember-inflector';

export default JSONAPIAdapter.extend(ImportExportMixin, {
  _debug: false,
  _indices: computed(function () {
    return {};
  }),
  coalesceFindRequests: false,

  // TODO: v2.0 - What are the defaults now? What versions to support?
  isNewSerializerAPI: true,

  // TODO: v2.0 - Can we deprecate or remove that? What are the defaults now? What versions to support?
  // Reload behavior
  shouldReloadRecord() {
    return true;
  },
  shouldReloadAll() {
    return true;
  },
  shouldBackgroundReloadRecord() {
    return true;
  },
  shouldBackgroundReloadAll() {
    return true;
  },

  generateIdForRecord() {
    return Math.random().toString(32).slice(2).substr(0, 8);
  },

  // Relationship sugar
  createRecord(store, type, snapshot) {
    snapshot.eachRelationship(function (name, relationship) {
      const { kind, options } = relationship;

      if (kind === 'belongsTo' && options.autoSave) {
        snapshot.record.get(name).then(function (record) {
          if (record) {
            record.save();
          }
        });
      }
    });

    return this._super.apply(this, arguments);
  },

  deleteRecord(store, type, snapshot) {
    snapshot.eachRelationship(function (name, relationship) {
      const { kind, options } = relationship;

      if (kind === 'hasMany' && options.dependent === 'destroy') {
        snapshot.record.get(name).then(function (records) {
          records.forEach(function (record) {
            record.destroyRecord();
          });
        });
      }

      if (kind === 'belongsTo' && options.autoSave) {
        snapshot.record.get(name).then(function (record) {
          if (record) {
            record.save();
          }
        });
      }
    });

    return this._super.apply(this, arguments);
  },

  // Polyfill queryRecord
  queryRecord(store, type, query) {
    let records = this._super.apply(this, arguments);

    if (!records) {
      var url = this.buildURL(type.modelName, null, null, 'queryRecord', query);

      // TODO: Document why this is needed or remove it!
      if (this.sortQueryParams) {
        query = this.sortQueryParams(query);
      }

      records = this.ajax(url, 'GET', { data: query });
    }

    return records.then(function (result) {
      return { data: result.data[0] || null };
    });
  },

  // TODO: v2.0 - What are the defaults now? What versions to support?
  // Delegate to _handleStorageRequest
  ajax() {
    return this._handleStorageRequest.apply(this, arguments);
  },

  // Delegate to _handleStorageRequest
  makeRequest(request) {
    return this._handleStorageRequest(request.url, request.method, {
      data: request.data,
    });
  },

  // Work arround ds-improved-ajax Feature Flag
  _makeRequest() {
    return this.makeRequest.apply(this, arguments);
  },

  // Remove the ajax() deprecation warning
  _hasCustomizedAjax() {
    return false;
  },

  // Delegate to _handle${type}Request
  _handleStorageRequest(url, type, options = {}) {
    if (this._debug) {
      console.log(url, type, options); // eslint-disable-line no-console
    }

    return new RSVP.Promise((resolve, reject) => {
      const handler = this[`_handle${type}Request`];
      if (handler) {
        const data = handler.call(this, url, options.data);
        run(null, resolve, { data: data });
      } else {
        run(null, reject, `There is nothing to handle _handle${type}Request`);
      }
    }, 'DS: LocalStorageAdapter#_handleStorageRequest ' + type + ' to ' + url);
  },

  _handleGETRequest(url, query) {
    const { type, id } = this._urlParts(url);
    const storage = get(this, '_storage');
    const storageKey = this._storageKey(type, id);

    if (id) {
      if (!storage[storageKey]) {
        throw this.handleResponse(404, {}, 'Not found', { url, method: 'GET' });
      }
      return JSON.parse(storage[storageKey]);
    }

    const records = this._getIndex(type)
      .filter(function (storageKey) {
        return storage[storageKey];
      })
      .map(function (storageKey) {
        return JSON.parse(storage[storageKey]);
      });

    if (query && query.filter) {
      const serializer = this.store.serializerFor(singularize(type));

      return records.filter((record) => {
        return this._queryFilter(record, serializer, query.filter);
      });
    }

    return records;
  },

  _handlePOSTRequest(url, record) {
    const { type, id } = record.data;
    const storageKey = this._storageKey(type, id);

    this._addToIndex(type, storageKey);
    get(this, '_storage')[storageKey] = JSON.stringify(record.data);

    return null;
  },

  _handlePATCHRequest(url, record) {
    const { type, id } = record.data;
    const storageKey = this._storageKey(type, id);

    this._addToIndex(type, storageKey);
    get(this, '_storage')[storageKey] = JSON.stringify(record.data);

    return null;
  },

  _handleDELETERequest(url) {
    const { type, id } = this._urlParts(url);
    const storageKey = this._storageKey(type, id);

    this._removeFromIndex(type, storageKey);
    delete get(this, '_storage')[storageKey];

    return null;
  },

  // TODO: Extract into utility functions in private/query.js
  _queryFilter(data, serializer, query = {}) {
    const queryType = typeOf(query);
    const dataType = typeOf(data);

    if (queryType === 'object' && dataType === 'object') {
      return getKeys(query).every((key) => {
        let queryValue = query[key],
          recordValue;

        // normalize type
        if (key === 'type' && typeOf(queryValue) === 'string') {
          queryValue = pluralize(queryValue);
        }

        // Attributes
        if (key === 'id' || key === 'type') {
          recordValue = data[key];
        } else {
          key = serializer.keyForAttribute(key);
          recordValue = data.attributes ? data.attributes[key] : undefined;
        }

        if (recordValue !== undefined) {
          return this._matches(recordValue, queryValue);
        }

        // Relationships
        key = serializer.keyForRelationship(key);
        if (data.relationships && data.relationships[key]) {
          if (isEmpty(data.relationships[key].data)) {
            return;
          }

          return this._queryFilter(
            data.relationships[key].data,
            serializer,
            queryValue
          );
        }
      });
    } else if (queryType === 'array') {
      // belongsTo
      if (dataType === 'object') {
        const queryMessage = query
          .map(function (item) {
            return getKeys(item).map(function (key) {
              return key + ': ' + item[key];
            });
          })
          .join(', ');

        throw new Error(
          'You can not provide an array with a belongsTo relation. ' +
            'Query: ' +
            queryMessage
        );

        // hasMany
      } else {
        return query.every((queryValue) => {
          return this._queryFilter(data, serializer, queryValue);
        });
      }
    } else {
      // belongsTo
      if (dataType === 'object') {
        return this._matches(data.id, query);

        // hasMany
      } else {
        return data.some((record) => {
          return this._queryFilter(record, serializer, query);
        });
      }
    }
  },

  _matches(recordValue, queryValue) {
    if (typeOf(queryValue) === 'regexp') {
      return queryValue.test(recordValue);
    }

    return recordValue === queryValue;
  },

  _urlParts(url) {
    const parts = url.split('/');

    // remove empty part
    parts.shift();

    let type = parts.shift();
    let id = parts.shift();

    if (type === this.modelNamespace) {
      type = `${type}/${id}`;
      id = parts.shift();
    }

    return {
      type: type,
      id: id,
    };
  },

  _storageKey(type, id) {
    return _buildKey(this, type + '-' + id);
  },

  // Should be overwriten
  // Signature: _getIndex(type)
  _getIndex() {},

  _indexHasKey(type, id) {
    return this._getIndex(type).indexOf(id) !== -1;
  },

  _addToIndex(type, id) {
    if (!this._indexHasKey(type, id)) {
      this._getIndex(type).addObject(id);
    }
  },

  _removeFromIndex(type, id) {
    this._getIndex(type).removeObject(id);
  },
});
