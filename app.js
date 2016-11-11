#!/usr/bin/env node

'use strict';


const Fs = require('fs');
const _ = require('lodash');
const Cheerio = require('cheerio');
const MD5 = require('blueimp-md5');
const Async = require('async');
const Request = require('request-promise-native');
const CookieKit = require('tough-cookie-kit');
const Moment = require('moment');
const Inquirer = require('inquirer');
const Chalk = require('chalk');
const Bunyan = require('bunyan');


const Log = Bunyan.createLogger({
    name: 'chijidun-cli',
    src: true
});
// Log.trace, Log.debug, Log.info, Log.warn, Log.error, and Log.fatal


let gCookie = Request.jar(new CookieKit('cookies.json'));
const gRequest = Request.defaults({
    'simple': false, // Get a rejection only if the request failed for technical reasons
    'resolveWithFullResponse': true, // Get the full response instead of just the body
    'followRedirect': false,
    'jar': gCookie
});

let gHeaders = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Encoding': 'gzip, deflate, sdch',
    'Accept-Language': 'zh-CN,zh;q=0.8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Host': 'wos.chijidun.com',
    'Pragma': 'no-cache',
    'Referer': 'http://wos.chijidun.com/order.html',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/50.0.2661.75 Safari/537.36 QQBrowser/4.1.4132.400'
};

let gInfo = {
    'cid': '',
    'time': '00:00:00',
    'members': {}, // 餐厅列表
    'address': {}, // 收获地址
    'order': false // 订单 id
};

main();

function main() {
    console.log(Chalk.yellow('欢迎使用 吃几顿(命令行版)~'));
    return procMain();
}

function isLogin(data) {
    return (data && data.headers && data.headers.location);
}

function procMain() {
    return Async.waterfall([
        function(done) {
            return getLogin().then(function(res) {
                return done(null, res);
            });
        },
        function(data, done) {
            if (isLogin(data)) {
                return done(null, data);
            }

            return menuLogin().then(function(aws) {
                return done(null, aws);
            });
        },
        function(data, done) {
            if (isLogin(data)) {
                return done(null, data);
            }

            return postLogin(data.phone, data.password).then(function(res) {
                if (res.statusCode !== 302) {
                    return done('登录失败!!!');
                } else {
                    return done(null, res);
                }
            });
        },
        function(data, done) {
            return getOrder().then(function(res) {
                return !(gInfo.cid = getCid(res.body)) ? done('获取 cid 失败!!!') : done(null, res);
            });
        },
        function(data, done) {
            showHtmlInfo(data.body);
            return getMembersAndOrder(gInfo.cid).then(function(res) {
                let jsonMembersAndOrder = res.body;
                gInfo.order = jsonMembersAndOrder.data.order;

                let $members = Cheerio.load(jsonMembersAndOrder.data.members);
                $members('.nav.nav-list > li').each(function(i, elem) {
                    gInfo.members[$members(elem).data('id')] = {
                        'name': $members(elem).text(),
                        'menus': {}
                    };
                });

                let $address = Cheerio.load(jsonMembersAndOrder.data.address);
                $address('li').each(function(i, elem) {
                    gInfo.address[$address(elem).data('id')] = $address(elem).find('.name').text();
                });

                return done(null, res);
            });
        },
        function(data, done) {
            let arrMid = _.keys(gInfo.members);
            return Async.map(arrMid, function(mid, cb) {
                return getMenu(mid).then(function(res) {
                    let jsonMenu = res.body;
                    let $menus = Cheerio.load(jsonMenu.data);
                    $menus('li').each(function(i, elem) {
                        let strMark = $menus(elem).find('.color-mark').text();
                        strMark = strMark ? ('(' + strMark + ')') : '';
                        gInfo.members[mid].menus[$menus(elem).data('id')] = $menus(elem).find('.title').text() + strMark;
                    });
                    return cb(null, jsonMenu);
                });
            }, function(err, res) {
                return err ? done(err) : done(null, res);
            });
        }
    ], function (err, res) {
        return err ? console.log(Chalk.red(err)) : showOrderInfo();
    });
}

function menuLogin() {
    let questions = [{
        'type': 'input',
        'name': 'phone',
        'message': '手机:',
        'validate': function(input) {
            let pass = input.match(/^1[3|4|5|7|8][0-9]\d{8}$/i);
            if (!input || !pass) {
                return '请输入已验证的手机号码';
            }
            return true;
        }
    }, {
        'type': 'password',
        'name': 'password',
        'message': '密码:',
        'validate': function(input) {
            if (!input) {
                return '请输入密码';
            }
            return true;
        }
    }];

    return Inquirer.prompt(questions);
}

function menuAddress() {
    let questions = [{
        type: 'list',
        name: 'address',
        message: '请选择收获地址:',
        choices: [],
    }];

    _.forEach(gInfo.address, function(address, id) {
        questions[0].choices.push({
            'name': address,
            'value': id,
        });
    });

    questions[0].choices.push(new Inquirer.Separator());
    questions[0].choices.push({'name': '返回', 'value': 'back'});

    return Inquirer.prompt(questions);
}

function menuOrder() {
    let questions = [{
        type: 'list',
        name: 'mid',
        message: '您想要点什么呢?',
        choices: [],
    }];

    _.forEach(gInfo.members, function(member, id) {
        questions[0].choices.push(new Inquirer.Separator());
        questions[0].choices.push({
            'name': member.name,
            'disabled': '-。-',
        });
        _.forEach(member.menus, function(menu, id) {
            questions[0].choices.push({
                'name': menu,
                'value': id,
            });
        });
    });

    questions[0].choices.push(new Inquirer.Separator());
    questions[0].choices.push({'name': '返回', 'value': 'back'});

    return Inquirer.prompt(questions);
}

function menuSaveOrder() {
    let questions = [{
        type: 'list',
        name: 'step',
        message: '您想要做什么?',
        choices: [
            {'name': '点餐', 'value': 'save'},
            {'name': '刷新', 'value': 'refresh'},
            new Inquirer.Separator(),
            {'name': '退出', 'value': 'exit'},
        ],
    }];

    if ((new Date().getTime()) >= getEndTime()) {
        questions[0].choices.shift();
    }

    return Inquirer.prompt(questions);
}

function menuDeleteOrder() {
    let questions = [{
        type: 'list',
        name: 'step',
        message: '您想要做什么?',
        choices: [
            {'name': '退餐', 'value': 'delete'},
            {'name': '刷新', 'value': 'refresh'},
            new Inquirer.Separator(),
            {'name': '退出', 'value': 'exit'},
        ],
    }];

    if ((new Date().getTime()) >= getEndTime()) {
        questions[0].choices.shift();
    }

    return Inquirer.prompt(questions);
}

function getEndTime() {
    let arrTime = gInfo.time.split(':');
    return (new Date().setHours(arrTime[0], arrTime[1], arrTime[2], 0));
}

function showHtmlInfo(strHtml) {
    let $order = Cheerio.load(strHtml);
    gInfo.time = $order('span[name=time]').eq(0).text() + ':00';
    console.log(Chalk.green(`欢迎 ${$order('.company-name').text()}(${$order('.company-desc').text()}) 的用户~`));
    console.log(Chalk.white(`订餐截止时间 `, Chalk.underline.bgRed(gInfo.time)));
}

function showOrderInfo() {
    if (gInfo.order === false) {
        console.log(Chalk.inverse(`您今天还未点餐哦!`));
        return menuSaveOrder().then(procOrderInfo);
    } else {
        let $lis = Cheerio.load(gInfo.order.lis);
        console.log(Chalk.magenta(`您今天的点餐订单信息:`));
        console.log(Chalk.white(`单号: ${gInfo.order.id}`));
        console.log(Chalk.white(`餐厅: ${$lis('span').text().split('|')[0]}`));
        console.log(Chalk.white(`套餐: ${gInfo.order.menus}`));
        console.log(Chalk.white(`地址: ${gInfo.order.address}`));
        return menuDeleteOrder().then(procOrderInfo);
    }
}

function updateOrderInfo() {
    return getMembersAndOrder(gInfo.cid).then(function(res) {
        let jsonMembersAndOrder = res.body;
        if (!jsonMembersAndOrder.data) {
            console.log(Chalk.white(`Cookie 失效, 需要`, Chalk.underline.bgRed(`重新登录`)));
            return procMain();
        }
        gInfo.order = jsonMembersAndOrder.data.order;
        return res;
    });
}

function procAddress(mid, aws) {
    if (aws.address === 'back') {
        return menuOrder().then(procOrder);
    } else {
        return saveOrder(mid, aws.address).then(function(res) {
            return updateOrderInfo().then(function(res) {
                return showOrderInfo();
            });
        });
    }
}

function procOrder(aws) {
    if (aws.mid === 'back') {
        return showOrderInfo();
    } else {
        return menuAddress().then(function(_aws) {
            return procAddress(aws.mid, _aws);
        });
    }
}

function procOrderInfo(aws) {
    switch(aws.step) {
        case 'save':
            return menuOrder().then(procOrder);
        case 'delete':
            return deleteOrder(gInfo.order.id).then(function(res) {
                return updateOrderInfo().then(function(res) {
                    return showOrderInfo();
                });
            });
        case 'refresh':
            return updateOrderInfo().then(function(res) {
                return showOrderInfo();
            });
        case 'exit':
            // return getLogOut().then(function(res) {
                process.exit(0);
            // });
    }
}

function getCid(strHtml) {
    let regexCid = /cid\s=\s'(\d+?)';/i;
    let arrCid = strHtml.match(regexCid);
    return ((arrCid.length !== 2) ? null : arrCid[1]);
}

function getLogin() {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': 1
    });

    return getHtml('http://wos.chijidun.com/login.html', headers);
}

function postLogin(username, password) {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'http://wos.chijidun.com',
        'Referer': 'http://wos.chijidun.com/login.html',
        'Upgrade-Insecure-Requests': 1
    });

    let form = {
        'LoginForm[username]': username,
        'LoginForm[password]': MD5(password),
        'LoginForm[autoLogin]': 1
    };

    return postForm('http://wos.chijidun.com/login.html', headers, form);
}

function getLogOut() {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'http://wos.chijidun.com/order.html',
        'Upgrade-Insecure-Requests': 1
    });

    return getHtml('http://wos.chijidun.com/logout.html', headers);
}

function getOrder() {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'http://wos.chijidun.com/login.html',
        'Upgrade-Insecure-Requests': 1
    });

    return getHtml('http://wos.chijidun.com/order.html', headers);
}

function getMembersAndOrder(cid) {
    let headers = _.assign({}, gHeaders, {
        'X-Requested-With': 'XMLHttpRequest'
    });

    let data = {
        'cid': cid,
        'date': Moment().format('YYYY-MM-DD'),
        'mealType': 3 // 1:早餐 2:午餐 3:晚餐
    };

    return getJson('http://wos.chijidun.com/order/getMembersAndOrder.html', headers, data);
}

function getMenu(mid) {
    let headers = _.assign({}, gHeaders, {
        'X-Requested-With': 'XMLHttpRequest'
    });

    let data = {
        'mid': mid,
        'date': Moment().format('YYYY-MM-DD'),
        'type': 3 // 1:早餐 2:午餐 3:晚餐
    };

    return getJson('http://wos.chijidun.com/order/getMenu.html', headers, data);
}

function saveOrder(menuId, addrId) {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'http://wos.chijidun.com',
        'Referer': 'http://wos.chijidun.com/order.html',
        'X-Requested-With': 'XMLHttpRequest'
    });

    let form = {
        'items': menuId + ':1',
        'addrId': addrId,
        'mealType': 3, // 1:早餐 2:午餐 3:晚餐
        'date': Moment().format('YYYY-MM-DD')
    };

    return postForm('http://wos.chijidun.com/order/saveOrder.html', headers, form);
}

function deleteOrder(orderId) {
    let headers = _.assign({}, gHeaders, {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'http://wos.chijidun.com',
        'Referer': 'http://wos.chijidun.com/order.html',
        'X-Requested-With': 'XMLHttpRequest'
    });

    let form = {
        'orderId': orderId
    };

    return postForm('http://wos.chijidun.com/order/deleteOrder.html', headers, form);
}

function memberFull(mid) {
    let headers = _.assign({}, gHeaders, {
        'X-Requested-With': 'XMLHttpRequest'
    });

    let data = {
        'mid': mid,
        'date': Moment().format('YYYY-MM-DD'),
        'type': 3 // 1:早餐 2:午餐 3:晚餐
    };

    return getJson('http://wos.chijidun.com/order/memberFull.html', headers, data);
}

function getMember(mid) {
    let headers = _.assign({}, gHeaders, {
        'X-Requested-With': 'XMLHttpRequest'
    });

    let data = {
        'id': mid,
    };

    return getJson('http://wos.chijidun.com/order/getMember.html', headers, data);
}

function getHtml(url, headers, data) {
    let options = {
        'url': url,
        'headers': headers,
        'qs': data
    };
    return get(options);
}

function getJson(url, headers, data) {
    let options = {
        'url': url,
        'headers': headers,
        'qs': data,
        'json': true
    };
    return get(options);
}

function postJson(url, headers, json) {
    let options = {
        'url': url,
        'headers': headers,
        'body': json,
        'json': true
    };
    return post(options);
}

function postForm(url, headers, form) {
    let options = {
        'url': url,
        'headers': headers,
        'form': form
    };
    return post(options);
}

function get(options) {
    return reqHttp(_.assign({}, options, {
        'method': 'GET'
    }));
}

function post(options) {
    return reqHttp(_.assign({}, options, {
        'method': 'POST'
    }));
}

function reqHttp(options) {
    return gRequest(options)
        .then(procReqSucceeded)
        .catch(procReqFailed);
}

function procReqSucceeded(response) {
    return response;
}

function procReqFailed(error) {
    return Log.error(error);
}

